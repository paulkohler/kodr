# Phase 233 — Staged Pipeline: Apply Pending Draft Writes on STAGED_DONE (W4 Parity)

## Motivation (confirmed silent-data-loss bug)

In `runStagedPrompt` (`src/run-pipeline.mjs`), when a model writes a file via the
`write_file` tool (captured in the registry's `proposalDraft`) and then returns a
STAGED_DONE completion envelope (`{status:"OK", files:[], messages:[{content:
"...STAGED_DONE..."}]}`), the draft's pending write is **silently discarded** — the
file is never applied to disk.

Verified live (`final-audit-2/content-api`, recorded in `process/failures.jsonl`
`final-audit-2-dogfood`): the model did `write_file(server.test.mjs)` (10202
bytes, captured in the draft), looped on `run_command` (blocked by the
pending-write guard), then — after the phase-232 nudge — returned STAGED_DONE with
`files:[]`. Result: `server.test.mjs` was NOT on disk, the implement-2 stage had
`writeCount:0`, verification ran with zero test files, the run failed. Phase 232
(just shipped) **worsens** this: its nudge steers the model to STAGED_DONE while a
draft write is pending.

## Root cause

The staged per-stage loop only consults the draft when the envelope is null
(the W3 fallback at ~line 1955: `if (!proposal) { ...mergeProposalWithDraft(draft,
null)... }`). A STAGED_DONE response parses to a VALID, non-null proposal, so the
fallback is skipped; `proposalPaths` returns `[]`; the empty-paths branch
(~line 2014) sets `done=true` and breaks, dropping the draft. The MAIN (non-staged)
pipeline already does the right thing — the **W4 merge** at ~lines 1080-1088:
`proposal = mergeProposalWithDraft(capturedDraft, proposal)` even when a non-null
envelope exists (envelope wins per path). The staged path lacks this.

## `mergeProposalWithDraft(draft, envelopeProposal)` semantics (confirmed)

`src/tool-calls.mjs`: argument order `(draft, envelope)`; **envelope wins per path**
for `files` (draft files inserted first, envelope overwrites by path); patches
concatenated `[...draftPatches, ...envelopePatches]`; `status`/`scratchpad`/
`messages` taken from the envelope (so the STAGED_DONE message carries through);
**empty-draft no-op**: returns the envelope unchanged when the draft is empty.

## The fix

### 1. W4-parity merge (replace the ~1954-1962 block)

Hoist `capturedDraft`/`draftNonEmpty` out of the `if (!proposal)` block and add
the non-null merge:

```js
lastProposal = proposal;
// Phase 233: merge the captured draft into a VALID envelope too (W4 parity with
// the main pipeline ~1080-1088), not only the null-envelope W3 fallback. A
// STAGED_DONE envelope (files:[]) is non-null, so without this the draft's
// pending write_file is silently dropped at the empty-paths check below.
const capturedDraft = completion.proposalDraft ?? null;
const draftNonEmpty = capturedDraft !== null && !capturedDraft.isEmpty;
if (!proposal) {
  if (draftNonEmpty) {
    proposal = mergeProposalWithDraft(capturedDraft, null);
  }
} else if (draftNonEmpty) {
  proposal = mergeProposalWithDraft(capturedDraft, proposal);
}
lastProposal = proposal; // reflect the merged result in the run summary
```

The `if (!proposal)` ProposalMissingError guard below is unchanged (only fires
when both envelope and draft are empty).

### 2. Capture STAGED_DONE intent BEFORE the empty-paths check

After `const stageMessages = proposal?.messages || [];` (~1975), add:

```js
// Phase 233: capture STAGED_DONE before the empty-paths branch — after a W4 merge
// the merged proposal has paths > 0, so that branch (which used to honor
// STAGED_DONE) no longer fires; we honor it after apply instead.
const stagedDoneSignal = stageMessages.some((m) =>
  m.content?.includes('STAGED_DONE'),
);
```

Leave the existing empty-paths branch's inline `stageMessages.some(...)` check
byte-identical (the empty-draft regression path).

### 3. Apply-then-done (after the successful-apply bookkeeping, ~after line 2181)

After `allWrites.push(...)`, `clearFiles(appliedPaths)`, `noProgressTurns=0`,
`safeWriteSteered=false`, and the normal stageRecord push, add:

```js
// Phase 233: the model signaled STAGED_DONE in the SAME response that carried the
// pending draft write. The write is now applied (and cleared from the draft), so
// honor completion in this stage instead of burning another to re-signal.
if (stagedDoneSignal) {
  done = true;
  break;
}
```

Do NOT push a second stageRecord (the normal-apply record already has the correct
`writeCount`/`appliedPaths`; a second would double-count in aggregations).

### 4. Zero-applied + STAGED_DONE short-circuit (top of the ~2133 zero-applied branch)

If the merged proposal's writes all no-op (`writeResult.writes.length === 0`) but
the model signaled STAGED_DONE, complete rather than treating as no-progress:

```js
if (writeResult.writes.length === 0) {
  if (stagedDoneSignal) {
    done = true;
    stageRecords.push({
      done,
      name: `implement-${stageIndex}`,
      appliedPaths: [],
      proposedPaths: paths,
      responseChars: completion.text.length,
      writeCount: 0,
    });
    break;
  }
  // ...existing phase-225 no-progress / implicitDone logic unchanged...
```

## Edge cases (decisions)

- Draft + envelope both list files + STAGED_DONE: union applied, envelope wins per
  path, single `allWrites.push` (no double-count). Patch-dedup caveat is
  pre-existing (same as main W4) — out of scope.
- Empty draft + STAGED_DONE files:[]: merge skipped (no-op), empty-paths branch
  fires exactly as today.
- Merge over `maxStageWrites`: existing `StagedProposalTooLargeError` fires against
  the merged set — correct, loud failure.
- `SafeWriteError` on apply (phase 224): apply-then-done is AFTER the apply, so a
  throw bypasses it; steer precedence preserved.
- `clearFiles` runs before the break → draft consistent, no double-apply.

## Work items

- [x] W4-parity merge (hoist draft, add non-null `else if` merge) in
  `runStagedPrompt`.
- [x] Capture `stagedDoneSignal` before the empty-paths check.
- [x] Apply-then-done break after the successful-apply bookkeeping.
- [x] Zero-applied + STAGED_DONE short-circuit.
- [x] Tests in `test/app.test.mjs` (`describe('Phase 233 ...')`, reuse
  `startFakeModelServer`/`makeWriteFileTurn`/`makeEnvelopeTurn`/`writeNativeProfile`;
  a `write_file` turn (finish tool_calls) followed by a STAGED_DONE envelope turn
  (finish stop) collapses into ONE stage with a non-empty draft): (a) THE BUG —
  draft write + STAGED_DONE files:[] → file IS applied AND done (pre-fix this
  FAILS); (b) regression — STAGED_DONE empty draft → done, writeCount 0; (c) union
  — draft + envelope both list files, envelope wins per overlapping path, no
  double-count; (d) dropped — harness cannot produce zero-write from full-file write;
  noted in test file. Confirmed the existing phase 215/224/225/226 staged tests pass
  unchanged.
- [x] `npm run format`, run tests, `npm run check`.
- [x] `process/decisions.jsonl`: the W4-parity + apply-then-done decision,
  cross-referencing `failures.jsonl` `final-audit-2-dogfood`.
- [x] `process/failures.jsonl`: do NOT duplicate (already recorded as
  `final-audit-2-dogfood`).
- [x] `blog/233-staged-draft-apply-on-staged-done.md`: "The bug the safety net
  created."
- [x] `roadmap.md`: append `- [x] 233 Staged Pipeline: Apply Pending Draft Writes
  on STAGED_DONE (W4 Parity)`.
- [x] `package.json`: bump `0.0.232` → `0.0.233`.
- [x] `NEXT.md`: update frontier note to 233 (no candidate to delete — this bug
  was discovered in the final audit, not queued).
- [x] Commit.

## Must NOT change (regression guard)

- Main-pipeline W4 merge.
- Phase 224 implicitDone (gated on `safeWriteSteered`; no STAGED_DONE message →
  `stagedDoneSignal` false → unaffected).
- Phase 225 two-zero-stage auto-advance (new short-circuit only fires on an
  explicit STAGED_DONE message; existing logic byte-identical below it).
- safeWriteSteer logic, the empty-paths STAGED_DONE branch, `maxStageWrites`,
  `clearFiles`, non-staged behavior.
