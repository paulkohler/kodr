# Phase 224 — Stage Auto-Advance on Zero New Unique Writes

## Goal

Break the staged-execution budget-exhaustion loop deterministically, without
relying on model cooperation. When a stage's writes are all blocked because the
target files already exist on disk (`SafeWriteError` → `safeWriteSteer`), and the
*following* stage also produces zero newly-applied unique paths, treat the run as
implicitly complete: record an `implicitDone` stage, set `done = true`, and break
the loop instead of grinding to `StagedIncompleteError`.

## Why this is next

This is the only candidate in the staged-pipeline cluster that is purely
mechanical and model-independent. Phase-223 proved qwen3.6 ignores both embedded
tool-error hints and the STAGED_DONE escalation envelope, so the "synthetic user
turn" candidate is a model-behaviour gamble that can't be verified in unit tests
without faking a cooperative model anyway, whereas this fix is provable against
scripted responses that *never* emit STAGED_DONE. It directly closes the live
open problem (verification stages with nothing left to write looping to
`StagedIncompleteError`), builds incrementally on the phase-216 `safeWriteSteer`
machinery, and carries no risk of false completion because it only triggers after
the harness itself has steered at least once and observed two consecutive
no-real-progress stages.

## Changes

### `src/run-pipeline.mjs` — `runStagedPrompt`

The loop has two no-progress exits that each `continue` without breaking: the
`paths.length === 0` branch (increments `noProgressTurns`, never auto-completes
unless the model emits `STAGED_DONE`) and the `SafeWriteError` → `safeWriteSteer`
branch (sets `safeWriteSteering`, records `safeWriteSteer: true`, continues with
zero writes recorded). Nothing connects them, so a run that repeats "re-write
already-applied files" grinds until `stageIndex` exceeds `maxExecutionStages` and
falls through to `StagedIncompleteError`.

1. **Add a steer-tracking flag** alongside `let safeWriteSteering = null;`:
   `let safeWriteSteered = false;`

2. **In the `paths.length === 0` branch:** before incrementing `noProgressTurns`,
   if `!done && safeWriteSteered`, set `done = true`, push a stage record with
   `implicitDone: true`, and `break`. (A prior steer + a zero-write stage means
   the model has nothing new to apply.)

3. **In the `SafeWriteError` (`stageIndex > 1`) branch:** if `safeWriteSteered`
   is already true (a *second consecutive* steer — the model keeps re-emitting
   `files[]` for already-existing paths and will never converge), set
   `done = true`, push an `implicitDone: true` record, and `break`. Otherwise set
   `safeWriteSteered = true` and continue as today.

4. **Reset the flag on real progress:** where `noProgressTurns = 0;` runs after a
   successful apply with ≥1 write, also set `safeWriteSteered = false`. This keeps
   the trigger strictly to *consecutive* steered/zero stages — any stage that
   applies a real write clears it, so write→steer→write→steer never false-completes.

Edge cases: `safeWriteSteered` only becomes true for `stageIndex > 1` (existing
guard), so a stage-1 `SafeWriteError` still breaks fatally (phase-216 test stays
green). `implicitDone` sets `done = true`, which flows to `summary.staged.done`
and gates the `StagedIncompleteError` synthesis (`if (!done && !writeError && …)`),
so that error is no longer produced for this path. An implicit-done run that
applied writes earlier but ran no test still surfaces `StagedUnverifiedError` as
today — implicit completion must reach the same post-loop state as an explicit
STAGED_DONE. No change to `completeWithToolCalls` / `tool-calls.mjs` this phase.

## Tests

New `describe('runStagedPrompt zero-new-write auto-advance (Phase 224)')` in
`test/app.test.mjs`, mirroring the phase-216 block: `startFakeModelServer` with
scripted `proposalResponse(...)` turns, driven via
`main(['run', …, '--staged', '--yes', '--json'])`, asserting against
`summary.json`. **None emit `STAGED_DONE`** — completion must come from the harness.

1. **safeWriteSteer then zero-write stage auto-completes** — plan; stage 1 writes
   new `src/answer.mjs` (applies); stage 2 re-writes it via `files[]` → steer;
   stage 3 returns `{status:'OK', files:[], messages:[…no STAGED_DONE]}`. Assert no
   `StagedIncompleteError`; `staged.done === true`; `implement-3` has
   `implicitDone === true`; `src/answer.mjs` keeps the stage-1 content; stages < cap.
2. **two consecutive safeWriteSteer stages auto-complete** — plan; stage 1 writes
   new `src/a.mjs`; stages 2 and 3 both re-write it via `files[]`; the second steer
   triggers implicit done. Assert `implement-2.safeWriteSteer === true`,
   `implement-3.implicitDone === true`, no `StagedIncompleteError`.
3. **real write between steers does NOT auto-complete (flag resets)** — plan;
   stage 1 writes `src/a.mjs`; stage 2 re-writes it → steer; stage 3 writes a new
   `src/b.mjs` (resets flag); stage 4 returns zero paths, no STAGED_DONE. Assert
   stage 4 is **not** `implicitDone` (plain `noProgress: true`); `src/b.mjs` exists.
4. **zero-write stage with no prior steer still records no-progress** — plan;
   stage 1 returns zero paths, no STAGED_DONE, no prior steer. Assert `noProgress:
   true`, no `implicitDone`, `done` stays false (pins the unchanged path).

Reuse `proposalResponse` and `startFakeModelServer`; no live model.

## Done criteria

- [x] `runStagedPrompt`: `safeWriteSteered` flag; auto-complete on prior-steer +
      zero writes; auto-complete on second consecutive `SafeWriteError`; flag and
      `noProgressTurns` reset on a real applied write.
- [x] Stage-1 `SafeWriteError` still breaks fatally; existing staged tests stay green.
- [x] New Phase 224 describe block (four cases above), scripted fake-model only.
- [x] `npm run format` clean.
- [x] Full test suite passes.
- [x] `npm run check` clean.
- [x] `process/decisions.jsonl` entry (rule, trigger conditions, rationale).
- [x] Blog post `blog/224-stage-auto-advance-zero-writes.md`.
- [x] Delete the shipped "Stage auto-advance on zero new unique writes" item from
      `NEXT.md` (FIFO); update the frontier note if it references this open problem.
- [x] `roadmap.md`: `- [x] 224 Stage Auto-Advance on Zero New Unique Writes`.
- [x] Commit (small, focused; do not push).

## Risks / things to watch

- **False completion** is the main risk — mitigated by requiring a prior steer and
  resetting the flag on every real applied write. Test case 3 is the explicit guard.
- **`StagedUnverifiedError`**: don't suppress it; an implicit-done run that applied
  writes but ran no test should reach the same post-loop state as explicit STAGED_DONE.
- **`summary.ok` / `summary.staged.done`** must resolve identically to an
  explicit-STAGED_DONE run so forensics/trends treat implicit and explicit the same.
  `implicitDone` is additive, for observability only.
- **Stay out of `tool-calls.mjs`** — the synthetic-user-turn and sentinel-wording
  ideas remain in `NEXT.md` for later phases.
