# Phase 147: Recovering a Token-Truncated Envelope Tail

The plumbing usually works now. After the 109–120 extraction-resilience arc, the
common local-model corruptions — gemma's `<|"|>` pseudo-token, gpt-oss's
array-boundary brace slips, qwen's duplicate-key clusters — all have named repair
rules and a corpus-replay guard. The remaining failures are mostly in the *code*
the models write, not in our ability to read what they sent.

This phase is one of the exceptions: a plumbing failure that threw away a full,
correct response.

## The capture

A 2026-06-15 examples-trial ran a four-file Markdown-to-HTML converter task
against `qwen/qwen3.6-35b-a3b`. The model emitted an incomplete JSON envelope
and stopped — `finish_reason: stop`, capped by a stray `</parameter>` (a Qwen
tool-call template tag). The envelope looked like this at the tail:

```
{"status":"OK","messages":[...],"files":[{"path":...,"content":...   <-- ] and } never came
});\n"}
</parameter>
```

The root `{` and the `files` array `[` were open. The last file object was closed
with `}`. But the `files` array `]` and the root `}` were never emitted — and a
stray `</parameter>` jinja/tool artifact trailed the final brace.

`extractProposal` returned `null`, the run reported `ProposalMissingError`, and
all four files the model *did* produce were discarded. `summary.json`:
`proposalFound:false`, `writeCount:0`.

## Why the existing rules missed it

The brace-walker (`braceWalkFrom`) cannot close the truncated root object, so it
never enumerates the outer envelope as a candidate at all. The only fragments
that parse — the `messages` array, a lone `{level,content}` object — are not
proposal envelopes, so extraction finds nothing.

Neither prior truncation rule fires:

- **R4 `gpt-oss-unclosed-file-object`** (phase 137) inserts a `}` when a file
  object is left open *before* the array `]`. Here the file object *is* closed and
  there is no `]` to anchor on.
- **R5 `qwen-duplicate-key-cluster`** (phase 118) splits files emitted as
  duplicate keys in one object. This capture has that shape too — but splitting
  the cluster still leaves the array and root unclosed, so it doesn't parse.

The capture needs **both**: R5 to split the cluster into four objects, then a new
rule to close the truncated tail.

## R6: `truncated-envelope-tail`

`applyTruncatedEnvelopeRule` is a position-aware, string-aware single pass. It
tracks a stack of expected closers (`}` for `{`, `]` for `[`) and remembers
`lastSafeEnd`: the index right after the most recent container close that left
the stack still open — i.e. the end of a *completed element* it can close back
to. It stops at end-of-text, or at the first structural-level garbage character
while the stack is still open (the `<` of `</parameter>` is exactly that), and
returns the prefix up to `lastSafeEnd` plus the still-open closers, innermost
first.

Two guards keep it honest, both inherited from the phase-137 "recover or reject,
never silently mangle" principle:

- **Idempotent on valid JSON.** A balanced document returns to an empty stack, so
  the rule never fires. Prose-wrapped JSON and multi-block responses pass through
  untouched.
- **Anchor required.** If the stream is cut *before any element completes inside
  the open container*, `lastSafeEnd` is never set and the rule leaves the text
  alone. A half-written file is not a produced file — better a clean miss than a
  recovered fragment of garbage.

It wires in after R5 in the structural chain (split first, then close) and after
R4 in `extractJson`'s full-text pre-pass. `extractJson` deliberately still does
*not* run R5 there: closing a truncation is structural completion, but splitting
duplicate keys could silently mask a genuine duplicate-key error, so that stays a
proposal-path concern.

## The self-inflicted regression

The first cut of R6 broke an existing test — the gemma `<|"|>` decode-artifact
envelope lost its `files` array. The pseudo-token contains an inner `"`, which
closed the value string early and exposed the following `|` as a structural-level
"garbage" character while the file object was open. R6 dutifully treated it as a
truncation point and closed back to the previous completed element (`messages
[]`), producing a perfectly valid but completely wrong `{status, messages}`
object — which then *won* the candidate race, because repaired candidates are
tried first.

The lesson: structural truncation analysis is only meaningful on text whose
string boundaries are real. R6 now normalizes decode artifacts (the blanket
rules) on a scan copy *before* walking, and — crucially — returns the original
text unchanged when it doesn't fire, so the blanket rule downstream still counts
and replaces `<|"|>` as it always did.

## Result

The real capture now recovers all four files, with
`repairs: [qwen-duplicate-key-cluster, truncated-envelope-tail]` recorded in the
extraction metadata (visible in `kodr why`). The capture is saved verbatim as a
corpus fixture, so the manifest-driven replay (phase 123) guards it permanently.
Full suite green at 1421 tests.

## A correction worth recording

The first draft of this post — and the failure log, and NEXT.md — called this an
"output-token-limit truncation." Re-deriving from the raw artifacts disproved it:
`finish_reason` was `stop`, not `length`; usage was 2309 completion tokens against
a 262144 context; and the request body carried only `{messages, model, tools}` —
no `max_tokens` cap and no sampling params at all. Nothing was length-capped. The
model stopped on its own after producing a malformed envelope and leaking a
`</parameter>` tool-template tag, while ignoring the tools channel it was offered.

So the genuinely-open follow-on is *generation control*, not transport. Kodr
sends no `temperature`, `repeat_penalty`, or `response_format`, so every run
inherits the server's chat-tuned preset (qwen: temp 0.8, repeat_penalty 1.1) —
poorly suited to structured/code output. Lowering temperature, setting
`repeat_penalty` to 1.0, and optionally `response_format` json_schema for the
envelope channel are the real source-level levers, all per-request. R6 recovers
the bytes that arrived regardless — the floor, not the fix.
