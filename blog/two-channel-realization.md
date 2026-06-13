# The Two-Channel Realization: What Kodr's Envelope Got Wrong

Companion to `tool-channel-arc.md`. That post told the story of phases
117–119. This one is about the idea underneath them — the one that took
eleven phases of fighting decode artifacts to see, and that arrived as a
question from outside the code: *does a native-tool harness even do it this
way? Is the chat result — the markdown — the path, rather than one schema to
always align to?*

The answer reframed the whole arc. Writing it down is the point of building
Kodr as a learning artifact.

## How a native-tool harness actually works

Take a harness built around a model that is genuinely good at tool use
(Claude Code is the reference point). Look for the status object — the thing
that says "here is what I did, here are the files, here is whether it
worked." It isn't there. Nothing like Kodr's `{status, messages, files,
patches}` exists anywhere in the loop.

Instead there are **two channels in every model turn**, doing different jobs:

1. **Tool calls** — structured, schema-constrained, parsed by the API
   itself. These are *actions*: `read_file`, `edit`, `write`, `bash`. File
   content travels here, inside tool arguments — the most-constrained channel
   on the stack.
2. **Assistant text** — free-form prose, rendered as markdown. This is
   *narration*: thinking, explaining, summarizing. It is never parsed for
   control flow.

A turn can carry both. The harness executes each tool call, appends a **tool
result** (applied / failed, test output, file written), and loops. The loop
ends when the model emits a turn with no tool calls. "Done" is *structural* —
the model has nothing left to do — not a field it fills in.

## The part that matters: status is computed, not declared

Here is the subtle bit, and the reason the architecture is robust. Status is
not on the text channel. It is not on the tool channel either. It is
**computed by the harness** from ground truth:

- Did the edit tool apply? The tool result says so — not the model.
- Did `node --test` exit zero? The tool result says so — not the model.
- Has the model stopped calling tools? The loop sees it.

When a model writes "I fixed the bug and the tests pass," that sentence is
*narration with zero authority*. The truth lives in the tool results, which
come from the environment. **The model never declares success. The harness
observes it.**

That one principle is what makes lying impossible. Kodr's worst failure —
phase 113's run that reported `ok/healed` while writing an unrelated file —
is unreachable in an architecture where status is computed from what the
environment did, not asserted by what the model said. We had been treating
goal-substitution as a model defect to detect. It is really a *design* defect:
we asked the model for a status field and then believed it.

## What the envelope conflated

Kodr's original contract put three different concerns onto one free-text JSON
object:

| Concern | Envelope | Two-channel |
|---|---|---|
| Actions (file writes) | JSON string values — *least* constrained | tool calls — *most* constrained |
| Narration (what / why) | `messages[]` in the JSON | assistant text (markdown) |
| Status (did it work) | a `status` field the model declares | computed by the harness from results |

Every row is on the wrong channel. The file content — the thing that needs
the *most* constraint — was on the *least* constrained channel, which is why
eleven phases bled into decode-artifact repair. Status — the thing that
should *never* be trusted from the model — was a field we asked it to fill
in. Narration was trapped inside a JSON string, competing with the schema for
the model's attention.

The arc migrated each concern to the right channel without ever naming the
plan: phase 117 moved actions to tool calls and status to verification; phase
119 moves narration to plain text and drops the envelope as the primary
contract.

## The envelope was not wrong — it was the wrong default

This is the learning, not a mea culpa. A single JSON object over plain text
is the correct *lowest-common-denominator* surface for a model-server-template
triple with **no native tool support** — and phase 118 proved that is a real,
measurable condition, not a hypothetical. Some triples parse tool calls into
structured fields; some leak tool syntax into text; some do neither. The
envelope works for all of them, because it asks nothing of the server's tool
layer.

The mistake was never the envelope. It was making the fallback the *only*
path — applying the lowest common denominator to models that were begging to
work at a higher one. gpt-oss hallucinated a write tool in every run; we kept
handing it a JSON schema.

So the end state is **strictly more general than a Claude-style harness**, not
a knockoff of one:

- native-tool triples → the two-channel loop
- no-tool triples → the envelope over text
- the probe *measures* which, per triple, instead of assuming

A harness built for one excellent model can assume tool use works. Kodr cannot
assume anything about an arbitrary local model on an arbitrary server, so it
measures and adapts. That generality *is* the product. The envelope earns a
permanent place — as the floor, not the ceiling.

## The workflow argument

There is a second reason beyond parsing, and it may be the deeper one. The
envelope forces the model to emit the entire solution in a single blind
generation — no reading a file, no running a test, no seeing a failure and
fixing it. That is exactly why qwen, asked for a word-frequency CLI,
one-shot-dumped 8 KB of envelope and got the counting logic subtly wrong: it
never got to run its own tests.

The tool loop is a better *cognitive* shape, not just a cleaner parse: write,
run, observe, correct. The envelope denied the model its feedback loop. The
migration buys grounded iteration as much as it buys a constrained channel —
the model gets to be an agent instead of a one-shot oracle.

## What Kodr keeps that Claude Code doesn't

One thing we deliberately did not copy: a native harness's edit tool writes to
disk immediately (behind a permission prompt). Kodr's whole posture is
proposals — capture into a draft, dry-run by default, review before apply. The
two-channel model does not require eager writes. The capture tools (117) put
the change on the tool channel and return "recorded, applies after
verification." Kodr stays Kodr: same constrained channel, same safety
property. The lesson was never "become Claude Code." It was "put each thing on
the channel that fits it, and measure which channel the model in front of you
can actually use."
