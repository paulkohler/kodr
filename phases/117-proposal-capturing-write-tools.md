# Phase 117 — Proposal-Capturing Write Tools

First phase of the tool-channel arc (see NEXT.md "Tool-Channel Arc" for
phases 118–119).

## Motivation

Kodr's contract puts file content in JSON string values inside free-decoded
text — the least-constrained channel the stack offers. Ten phases of decode
artifacts, boundary corruption, extraction repair, and prompt steering all
trace back to that choice. Meanwhile the models' tool calls travel the
*most*-constrained channel (LM Studio grammar-constrains and server-parses
them), and agentic-trained models keep reaching for write tools we don't
provide: gpt-oss hallucinated `write_file` in every run while corrupting its
envelope in every run (its tool-call arguments were valid every time);
devstral calls a native `files` tool 4–5 times per run, ignores all
steering, and never produces an envelope at all (0% usable).

Invert it: provide write-shaped tools that **capture into the proposal**
instead of writing to disk. The model gets the affordance its training
expects; file content rides the constrained channel; every safety invariant
holds (nothing touches disk until apply, dry-run default, status comes from
verification, not model claims).

This phase is strictly additive — the envelope contract keeps working
unchanged. Demoting it for tool-capable profiles is phase 119, after the
evidence is in.

Evidence: `process/failures.jsonl` phases 113–116-validation;
`~/src/kodr-testing/phase-115/OPERATOR-REPORT.md` (devstral baseline,
gpt-oss rescue); LM Studio native-tool-use docs
(lmstudio.ai/docs/developer/openai-compat/tools).

## Work items

### W1 — Capture tools

Two new tools in the registry, advertised alongside the existing read/verify
tools:

- `write_file {path, content}` — whole-file proposal entry. Returns a terse
  confirmation (`recorded write_file: <path> (<bytes> bytes) — applies when
  the task completes`).
- `edit_file {path, search, replace}` — proposal patch entry, same
  search/replace semantics as the existing patch format. Same confirmation
  shape.

Neither touches disk. Both validate `path` at capture time with the same
jail/safety rules the apply step enforces (reuse `jailedPath` /safe-writes
checks); a violating call returns a steering error, not a crash. Captured
entries accumulate in a `ProposalDraft` on the loop state: document order,
last-wins per path, `write_file` and `edit_file` entries tracked separately
(files vs patches, mirroring the envelope fields).

### W2 — Per-profile tool alias map

Model profiles gain `toolAliases` (object, alias → canonical), with
defaults shipped for the trained names we have evidence or strong priors
for: `files` → `write_file` (devstral), `create_file` → `write_file`,
`str_replace_editor` → `edit_file` (OpenHands), `apply_patch` →
`edit_file`. Dispatch resolves aliases before the unknown-tool check; the
phase-115 steering message remains for genuinely unknown names. Alias hits
are recorded (W5). Argument-shape mismatches on aliased calls (devstral's
`files` schema is unknown — we have only seen it called with empty
arguments) return a steering error naming the canonical schema; expect the
live validation to iterate here and record what devstral actually sends.

### W3 — Completion and status synthesis

When the tool loop ends (model stops calling tools, or budget exhausts) and
the `ProposalDraft` is non-empty:

- Skip the forced final envelope turn (F1) — captures already constitute a
  proposal. A model that wants to send a closing envelope still can (W4).
- Synthesize the proposal: captured files/patches, plus a generated message
  noting the channel (`N files captured via write tools`).
- `status` derives from the verification runner's result, never from model
  claims — `ok` only if verification passes. This is the same trust rule the
  goal-substitution failures demanded.

Empty draft + no envelope behaves exactly as today (no behaviour change for
the pure-envelope path — gemma must be unaffected when it doesn't use the
tools).

### W4 — Envelope/capture merge

If the model both captures writes and returns an envelope with files/patches,
merge per path with the **envelope winning** (it is the model's final word;
captures are working state). Envelope-only and capture-only both work.
`status`/`messages`/`scratchpad` from a returned envelope are honored as
today, except `status: ok` is still subordinate to verification (existing
behaviour). Merge provenance lands in `_extractionMeta`-style metadata on
the proposal (`channels: {captured: N, envelope: M, merged: K}`).

### W5 — Prompt and forensics

- Tools block (`renderToolsBlock`, src/system-env.mjs): the two new tools get
  lines; the "There is no write or edit tool" sentence is REPLACED with the
  positive contract (`write_file`/`edit_file` record proposed changes; the
  harness applies them after verification). Phase-114's lesson applies:
  state what to do, not what not to do. Keep the envelope contract text
  otherwise intact this phase (the envelope remains valid); prompt budget
  guard updated deliberately if the total moves.
- summary.json gains `proposalChannels` (captured/envelope counts, alias
  hits by name); `kodr why` surfaces it ("4 files via write tools, 0 via
  envelope").

## Testing

- Capture tool units: record, confirmation text, last-wins per path, jail
  violation steers.
- Alias dispatch: aliased name reaches the canonical tool, alias hit
  recorded, unknown name still steers, bad argument shape steers with
  canonical schema named.
- Loop integration (fake server): tool-call writes → draft → loop end →
  synthesized proposal → verification-derived status, both pass and fail
  branches; forced final turn skipped iff draft non-empty.
- Merge: envelope wins per path; capture-only; envelope-only unchanged
  (regression: existing envelope tests all stay green untouched).
- Streamed tool-call fragment reassembly with large `content` args (existing
  SSE reassembly tests extended with a multi-KB argument).
- Prompt assembly + budget guard updates deliberate, prefix stability tests
  green.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] W1: capture tools recording into ProposalDraft, path-jailed, never
      touching disk.
- [x] W2: profile toolAliases with shipped defaults; alias dispatch +
      steering.
- [x] W3: synthesized proposal on non-empty draft; status from verification;
      F1 skipped; empty-draft path byte-identical to today.
- [x] W4: envelope/capture merge with envelope-wins-per-path; provenance
      metadata.
- [x] W5: positive-contract tools block; proposalChannels in summary +
      `kodr why`.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/117-proposal-capturing-write-tools.md` (the inversion
      story: ten phases fighting the wrong channel).
- [x] NEXT.md entries shipped by this phase deleted (FIFO), if any apply.
- [ ] Version bumped to 0.0.117; suite green; committed.
- [ ] Live validation (after the commit, sequential, three models —
      gpt-oss and qwen favoured by user decision 2026-06-13; devstral
      deferred for a later circle-back since it is new and unfamiliar):
      `openai/gpt-oss-20b` greenfield — does content via tool args make
      the files[] boundary-corruption class irrelevant (compare against
      the 4-for-4 corruption record), and does it now prefer the declared
      write tools it always hallucinated; `qwen/qwen3.6-35b-a3b`
      greenfield — the natively-tool-supported family (per LM Studio
      docs): does the constrained channel work cleanly end-to-end, and
      does it improve on qwen's reasoning-then-silence envelope history;
      `google/gemma-4-26b-a4b` greenfield — regression guard: envelope
      path unchanged, no quality drop vs the phase-114 baseline. Record
      whether LM Studio's tool-argument constrained decoding handles
      multi-KB content strings without the json_schema-style stalls (open
      question from phase 112).
