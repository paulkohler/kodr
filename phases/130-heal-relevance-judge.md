# Phase 130 — Heal Relevance Judge (residual anti goal-substitution)

## Motivation

Phase 125 closed two of the three goal-substitution holes: the repair prompt now
carries the original task, and a zero-write/no-tests run is refused entry to the
heal loop. It left the subtler third case explicit in NEXT.md: a heal that
**writes something unrelated** and passes. The healing loop treats verification
as ground truth — `if (verification.ok) stopReason = 'healed'` — and its own
comment at the wrong-path check admits the gap: "a wrong-path write that passes
tests is healed." So a repair that invents a new file with its own tautological
test goes green and is reported as a clean heal.

Phase 125 put the original task into the repair context. That signal is exactly
what's needed to judge relevance: a heal is suspect when the writes that made it
pass touch neither the failing paths nor anything the task names.

Evidence: `src/healing.mjs:366` (wrong-path-but-passed comment); phase-125
`originalTask`; NEXT.md "Heal Relevance Judging".

## Design principles

1. **Flag, don't fail.** The judge records `goalSubstitutionSuspected`; it does
   not flip `ok`. A legitimate new-file repair the task names must not regress to
   a failure, and verification passing is still meaningful. The signal goes to
   forensics for human/aggregate review.
2. **Two exonerating signals.** A passing heal is suspect only when its writes
   touch no known path (failing test / shown sources — the existing
   `touchesKnownPath`) **and** none of the written paths/basenames appear in the
   original task (`writesReferenceTask`). Either signal clears it.
3. **Surfaced everywhere the heal is.** `summary.goalSubstitutionSuspected`,
   a `kodr why` Healing warn step, and a `kodr trends` counter.

## Work items

### C1 — Relevance judge in the heal loop

`writesReferenceTask(writes, originalTask)`: true if a written path or basename
appears in the task text. At the `verification.ok` success point, set
`goalSubstitutionSuspected = !touchesKnownPath && !writesReferenceTask(...)`.
Added to the loop result.

### C2 — Surfacing

- `summary.goalSubstitutionSuspected` at all three heal summary-build sites
  (omitted when false).
- `kodr why`: a Healing `warn` step ("suspected goal-substitution: verification
  passed via writes unrelated to the failing paths and the task").
- `kodr trends`: `goalSubstitutionSuspectedCount` aggregated and rendered with a
  ⚠ line when > 0.

## Testing

- `writesReferenceTask`: path/basename match, no-match, empty writes/task.
- Loop: an unrelated write that passes verification is flagged; a task-named
  write that passes is not.
- Regression: existing heal tests green.
- Full suite, format, check green.

## Done criteria

- [x] C1: `writesReferenceTask` + relevance judge at the heal-success point;
      `goalSubstitutionSuspected` in the loop result.
- [x] C2: summary field (3 sites), `kodr why` warn step, `kodr trends` counter.
- [x] Tests (relevance judge + surfacing); full suite green.
- [x] `process/decisions.jsonl` updated.
- [x] Blog post `blog/130-heal-relevance-judge.md`.
- [x] NEXT.md revised (thread closed); version bumped to 0.0.130; committed.
