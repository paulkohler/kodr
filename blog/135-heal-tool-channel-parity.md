# Phase 135: The Fix That Was Already There

The artifacts told the story the operator missed.

A phase-135 dogfood ran a three-file ESM CLI task against qwen/qwen3.6-35b-a3b and
devstral. Devstral passed cleanly. Qwen wrote correct application code but a broken test
file — `await import('node:fs')` inside non-`async` `node:test` callbacks, which is a
`SyntaxError`. Verification failed. Healing engaged.

In the heal turn, qwen did exactly the right thing. The raw artifact said
`finish_reason: tool_calls`. Three tool-call rounds: `read_file` on the broken test,
then two `edit_file` calls with the correct `async` fixes. The edits were real, the
diagnosis was correct. The harness logged `healStopReason: invalid_proposal`, one turn,
and left the broken file on disk.

## The operator's wrong turn

The initial read was: maybe the turn budget ran out, or the edits were applied partially
and then discarded. Both are plausible heal failure modes with familiar signatures. The
operator filed a note and moved on.

The artifacts disagreed. One turn — no budget exhaustion. The `repairs/turn-1/raw-response.json`
showed the complete `edit_file` content. Nothing was partially applied. The
`response.md` was two characters — an effectively empty text channel, exactly what a
tool-using model produces when its edits ride tool calls instead of prose.

The real story: `extractJson('')` throws `JsonExtractionError`. The heal loop caught it,
wrote `stopReason: invalid_proposal`, and broke. The correct captured edits, sitting in
`completion.proposalDraft`, were never read.

## The channel mismatch

The 117–119 arc inverted the core contract: file content now rides the tool-call channel
(a `ProposalDraft` accumulated from `write_file`/`edit_file` calls), not free-text JSON.
The main generation path was updated: when `draftNonEmpty`, `mergeProposalWithDraft(capturedDraft, null)`
*is* the proposal. Text-channel JSON extraction is the fallback for models that still use
the envelope.

The heal loop was never updated. `repairTurn` in `runHealingIfNeeded` called
`completeWithToolCalls` and then returned `{ raw, text }` — dropping
`completion.proposalDraft`. `runSelfHealingLoop` called
`normalizeRepairProposal(extractJson(completion.text))` unconditionally. For a
tool-using model, `completion.text` is `''`, extraction throws, and the loop stops with
`invalid_proposal`.

A model that correctly fixed the bug was reported as a heal failure.

## The fix

Channel parity. Two changes, no new machinery.

In `app.mjs`, `repairTurn` now reads `completion.proposalDraft` after the
`completeWithToolCalls` call. When the draft is non-empty (mirrors the main path's
`draftNonEmpty` guard) it returns `{ proposal: mergeProposalWithDraft(capturedDraft, null), raw, text }`.
Empty draft or the `completeWithContinuations` branch: `{ raw, text }` as before.

In `healing.mjs`, `runSelfHealingLoop` checks `turnResult.proposal` before calling
`extractJson`. If the proposal carries at least one file or patch, it is fed directly to
`normalizeRepairProposal`. Otherwise the text extractor runs as before. The
`invalid_proposal` break is kept for the case where both channels are empty — that is
still a real failure mode.

`normalizeRepairProposal` already coerces `{ files, patches, scratchpad? }`, which is
exactly the shape `mergeProposalWithDraft` produces. No schema change needed.

## What the test suite proved

Four new cases in `test/healing.test.mjs`:

1. Captured-draft heal with empty text: applies the file, heals. This is the regression.
2. Envelope-only (text returns valid JSON, no proposal key): still heals. The fallback
   path is intact.
3. Empty draft (`{ files: [], patches: [] }`) plus valid envelope text: the envelope is
   used. An empty draft does not suppress a valid text response — the `length > 0` guard
   ensures it.
4. Both channels empty: `stopReason: invalid_proposal`. Unchanged.

The full suite was 1351 tests before this phase and 1355 after. All green.

## The lesson in the artifacts

The operator's narrative — "turn budget" or "partial edit discard" — was a plausible
story from the surface symptom alone. The artifacts gave the real story in about three
minutes: one turn, `invalid_proposal` in the turn record, correct tool-call content in
`raw-response.json`, empty `response.md`. The channel-mismatch diagnosis was then
directly verifiable by reading the seventeen lines of `repairTurn` in `app.mjs`.

The forensics apparatus from phases 106 and 128 — artifacts written per-turn,
`repairs.json`, `raw-response.json`, `turn-meta.json` — existed exactly for this. The
lesson is to read them first, not after the wrong fix is half-written.
