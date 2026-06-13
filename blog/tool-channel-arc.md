# The Tool-Channel Arc: How a Docs Page and Four Misbehaving Models Rewired Kodr

This is the story behind phases 117–119 — not the implementation (each phase
has its own post) but the conversation that led to gutting kodr's central
contract. It happened across two days of dogfooding chats, and the reasoning
deserves capturing because none of it was planned: every step was forced by
evidence.

## The taxonomy that wouldn't stop growing

By phase 116 we had a four-model failure taxonomy, built one painful run at
a time:

- **qwen3.6** put everything in reasoning and then went silent.
- **gemma-4** narrated sequences of JSON blocks and emitted a `<|"|>`
  pseudo-token that corrupted its envelopes — sometimes as a closing quote,
  sometimes swallowing the `":"` separator entirely.
- **gpt-oss-20b** corrupted the same `files[]` object boundary in four runs
  out of four, each time by exactly one character, each time differently —
  and called a nonexistent `write_file` tool 4–5 times per run despite an
  explicit prompt line saying no write tool exists.
- **devstral**, brand new to the stable, called a native `files` tool
  exclusively, ignored every steering message and the repeat-call detector,
  and ended every run with an empty stop: 0% usable. (Its first contribution
  was crashing LM Studio outright — it emits `arguments: ""` where the spec
  says `"{}"`, and the server 500s when that gets echoed back in history.)

We treated each of these as a model defect and built harness defenses:
multi-envelope merging, braceWalk retries, a data-driven decode-artifact
rule list, structural repair rules replayed against the exact saved bytes
that failed in production. The defenses worked — phase 115's array-boundary
rule turned gpt-oss's corrupted envelopes into passing runs. But the
taxonomy kept growing, and that was the tell. You don't win an arms race
against the space of possible single-character corruptions.

## The question that reframed it

Mid-conversation, while looking at devstral's stubborn `files` calls, the
question came up: *are these models trained on specific tool signatures, so
when we define different ones they get confused — or do they simply express
the tool format they know? Is this per-model, or is kodr's definition just
not optimal?*

The honest answer was: all three. Tool use is a trained behaviour, not an
instruction-following one — devstral was RL-trained inside the OpenHands
scaffold, gpt-oss inside a harness with file tools. When the task obviously
requires writing files and the tool list contains no write-shaped tool, the
training prior beats the prompt. And crucially: the models weren't confused.
Their hallucinated tool calls were *perfectly well-formed* — for tools that
didn't exist. They were expressing the affordance they were trained on.

That observation flipped the blame. Kodr's no-write-tool design — everything
through one final JSON envelope — is a fine safety idea, but it fights the
gradient of how every agentic-trained model wants to behave. We'd been
paying for that fight in prompt lines, steering messages, and repair rules.

## The docs page that added the third layer

Then a section of LM Studio's documentation
(`/docs/developer/openai-compat/tools`) reframed it again. "Native tool use
support" means two things: the model's chat template knows how to format the
`tools` array into the prompt, *and* LM Studio knows how to parse that
model's tool-call syntax back into structured `tool_calls`. Models without
both get a generic fallback — prompt injection in, heuristic parsing out.

Suddenly several taxonomy entries looked less like model defects and more
like template/parser seams: gemma's leaked `<tool_call|>` fragment, the
pseudo-token corruption at tool boundaries, devstral's `arguments:""` crash
(LM Studio choking on a shape it had itself parsed). Even the phase-112
finding that `json_schema` constrained decoding stalls both qwen and gemma
was a server-layer property we'd initially read as model behaviour.

The unit of measurement was wrong. Reliability isn't a property of the
model — it's a property of the **(model, server, template) triple**. Ollama
and vLLM have the same layer (Modelfile templates; an explicit
`--tool-call-parser` flag), so nothing about this is LM Studio-specific.

## The inversion

With license to gut the whole approach, the thesis wrote itself:

**File content had been riding the least-constrained channel on the stack
(JSON string values in free-decoded text) while the most-constrained channel
(grammar-constrained, server-parsed tool calls) was the one the models kept
reaching for.** gpt-oss corrupted its envelope 4-for-4 while its rejected
`write_file` calls were valid every time. The model's preferred channel was
also the more robust channel, and kodr was only reading the broken one.

Four principles for the rewire:

1. Content rides the most-constrained channel available.
2. Adapt the surface, not the model — meet trained priors instead of
   prompting against them.
3. Safety invariants untouched — write tools *capture into the proposal*;
   nothing touches disk until apply; dry-run stays default.
4. Status is verified, never claimed — the verification runner decides
   ok/failed, which retroactively kills the goal-substitution failure class
   too.

Sequenced as an arc because the evidence had to lead: 117 adds
proposal-capturing write tools additively (envelope untouched); 118 measures
tool support empirically per (model, server) and picks the channel per
profile; 119 demotes the envelope for native-channel profiles only once the
measurements justify it. The extractor and its eleven phases of
battle-tested repair rules stay as the fallback — that's not deleted code,
it's the floor.

## What 117's validation said

One day after the plan: gpt-oss, handed the real `write_file`, used it
immediately — both files through tool args, multi-KB content byte-perfect,
no stalls (closing the phase-112 question), zero envelopes to corrupt. The
run still failed — on *generated code quality*, honestly reported by
verification. That's the failure landing where it belongs.

Gemma ignored the new tools and kept its envelope discipline: the additive
guarantee held. And qwen — the model from LM Studio's natively-supported
family — declined the tool channel entirely and produced a failure class
we'd never seen: both `files[]` objects collapsed into one object literal
with duplicate `path` keys. One model adopts eagerly, one conforms to the
old contract, one ignores the new affordance and invents a new corruption.
Three different triples. Which is exactly why phase 118 measures instead of
assumes.

## What 119 finally ran

Phase 119 closed the last gap the validation revealed: the envelope schema paragraph in `renderKodrBaseContract` was opening the system prompt with `files`, `patches`, and `status` — nine occurrences of `files` before the tools-primary wording even appeared. Phase 118's reworded tools block was subordinate to the leading contract it never touched. Gemma and gpt-oss overrode the leading instruction; qwen obeyed it. The experiment of removing the envelope contract had never been run.

Phase 119 ran it. For profiles whose `toolWrites` resolves to `native`, the two-sentence tool-first contract replaces the full schema paragraph. The extractor and all its repair rules stay loaded as an empty-draft safety net: if the model emits envelope JSON anyway, it is parsed as a fallback; if not, one re-prompt re-introduces the envelope contract for that turn; if that also fails, `NativeNoProposalError` — never a silent empty proposal.

And the answer, from the live run with the envelope contract finally gone: **qwen adopted the tool channel.** Five turns, two files through `write_file`/`edit_file`, a plain-text summary, zero envelope, `recoveredVia: none` — the safety net never fired. The model that phase 118 had pronounced an envelope-preferring holdout was nothing of the kind; it had been obeying a contradictory prompt that led with the very schema we then blamed it for using. gpt-oss and gemma stayed on the tool channel too (4 and 2 captures, no regression), and the demoted prompt came in 986 characters lighter. All three runs reached verification and reported status from it — two failed on generated *code quality*, exactly where failures belong now that the model no longer gets to declare its own success.

The lesson worth keeping is not "tool calls beat envelopes." It is that a model's apparent preference can be an artifact of the prompt you wrote, and the only way to know is to remove the contradiction and look. Eleven phases of repair rules were treating a self-inflicted wound. The envelope survives as the measured fallback for triples that genuinely can't use tools — the floor, not the ceiling — and Kodr ends the arc adapting to the model in front of it instead of forcing every model through one schema. That generality is the deliverable.
