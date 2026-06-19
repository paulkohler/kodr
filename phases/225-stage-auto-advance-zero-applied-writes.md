# Phase 225 — Stage Auto-Advance on Zero Applied Writes (No-Op Patch Stall)

## Goal

Generalize phase 224's mechanical staged-loop completion beyond the
`files[]`-vs-existing `SafeWriteError` arm. A stage that applies zero real writes
(`writeResult.writes.length === 0`) is a no-progress stage regardless of how many
paths its proposal *claimed*. After N consecutive zero-applied-write stages — and
only when real writes were applied earlier in the run — auto-complete the loop
(`implicitDone` record, `done = true`, `break`) instead of grinding to
`StagedIncompleteError`. Secondary: make the stage record distinguish *applied*
from *proposed* paths so zero-write stages stop looking like progress in forensics.

## Why this is next

The phase-224 dogfood (`process/failures.jsonl` → `224-dogfood`) showed the
budget-exhaustion problem is only partly closed. The qwen3.6 stall against the
Express+SQLite notes API was not a `files[]` steer (no `SafeWriteError`) — it was
consecutive `edit_file` patches whose `search` strings no longer matched the
already-correct files. In `src/safe-writes.mjs preparePatches`, a patch with
`occurrences !== 1` goes to `failedPatches` and produces no `writes` entry, while
its path stays in `proposalPaths(proposal)`. So the phase-224 `safeWriteSteered`
arm never fires (no throw), the `paths.length === 0` branch never fires (proposal
still claims the path), and the successful-apply block runs with
`writeResult.writes.length === 0`, records `applied:true, writeCount:0`, resets
`noProgressTurns`, and continues — nothing ever breaks the loop. Like phase 224,
the fix is mechanical and model-independent, provable against scripted responses
that never emit `STAGED_DONE`.

## Changes

All in `src/run-pipeline.mjs`, `runStagedPrompt`. No change to `tool-calls.mjs`
or `safe-writes.mjs`.

### N and counter

**N = 2** consecutive zero-applied-write stages, gated on `allWrites.length > 0`.
The existing `noProgressTurns > 0` prompt arm already nudges on the *first*
zero-progress stage ("Previous implementation turn made no file changes…"); N=1
would pre-empt a model that re-read in one stage and writes the final slice next.
N=2 means one nudge, then break if the *next* stage is still zero-applied — the
model ignored the nudge. This matches the phase-224 second-consecutive-steer arm
and the `>= 2` no-progress thresholds already used in `watcher.mjs`/`healing.mjs`.
**Reuse `noProgressTurns`** — a zero-applied-write stage is semantically the same
no-progress event as a zero-proposed stage, and one counter (reset together on
every real write) is safer than two.

### Change 1 — successful-apply block: branch on `writeResult.writes.length`

- **`writeResult.writes.length === 0`** (no-op stage): do NOT push `allWrites`,
  do NOT reset `noProgressTurns` / `safeWriteSteered`, do NOT run inter-stage
  install. Auto-complete check:
  `if (!done && allWrites.length > 0 && noProgressTurns + 1 >= 2)` → `done = true`,
  push `{ done, implicitDone: true, name, proposedPaths: paths, appliedPaths: [],
  writeCount: 0, responseChars }`, `break`. Otherwise `noProgressTurns += 1`,
  append the no-progress corrective scratchpad, push `{ name, noProgress: true,
  proposedPaths: paths, appliedPaths: [], writeCount: 0, responseChars }`,
  `continue`.
- **`writeResult.writes.length > 0`** (real progress, unchanged flow): push
  `allWrites`, `clearFiles`, `noProgressTurns = 0`, `safeWriteSteered = false`,
  then push `{ applied, name, proposedPaths: paths, appliedPaths:
  writeResult.writes.map((w) => w.path), writeCount: writeResult.writes.length,
  responseChars }`. Inter-stage npm-install block stays as-is on this path only.

### Change 2 — forensics: applied vs proposed

Replace the misleading bare `paths` key with `proposedPaths` + `appliedPaths` in
the progress records (Change 1), and mirror `proposedPaths`/`appliedPaths` in the
phase-224 records that apply nothing (`paths.length === 0` STAGED_DONE/implicitDone/
noProgress; `safeWriteSteer`; second-steer `implicitDone`) — all get
`appliedPaths: []`. Error-terminal records (`StagedProposalTooLargeError`, the
fatal `SafeWriteError` record) keep their existing `paths` and are out of scope.
Verified: no production consumer reads `stages[].paths` (only tests do, and the
phase-216/224 tests read `.noProgress`/`.safeWriteSteer`/`.implicitDone`, not
`.paths`). If a consumer/test surfaces that reads `.paths`, keep `paths` as an
alias rather than dropping it.

### Three no-progress paths coexist (no double-count)

1. **Zero proposed** (`paths.length === 0`): `continue`/`break` before
   `prepareChanges`. 2. **`SafeWriteError` steer** (phase 224): `prepareChanges`
   throws → `catch`. 3. **Zero applied** (this phase): proposal claimed paths,
   `prepareChanges` didn't throw, produced zero writes. Mutually exclusive by
   condition, so a stage increments `noProgressTurns` at most once. A real applied
   write resets both `noProgressTurns` and `safeWriteSteered`, so
   `write → no-op → write → no-op` never accumulates a streak.

Post-loop logic unchanged: `StagedUnverifiedError` still fires for an implicit-done
run that applied writes but ran no test (do NOT suppress); `StagedIncompleteError`
stays gated on `!done`; `summary.ok` / `summary.staged.done` resolve identically
to an explicit STAGED_DONE run (`implicitDone` is observability-only).

## Tests

New `describe('runStagedPrompt zero-applied-write auto-advance (Phase 225)')` in
`test/app.test.mjs`, mirroring the phase-224 block. Scripted fake-model only; no
live model; none emit `STAGED_DONE` for the auto-complete cases. Each no-op patch
targets a file that exists but whose `search` string is absent (zero writes,
`proposalPaths().length === 1`).

1. **two consecutive no-op patch stages auto-complete (N=2)** — plan; stage 1
   writes new `src/notes.mjs` via `files[]`; stages 2 and 3 emit non-matching
   `patches[]` (zero writes each); streak hits 2 → implicitDone. Assert no
   `StagedIncompleteError`; `staged.done === true`; `implement-3` has
   `implicitDone === true`, `writeCount === 0`, `appliedPaths` deep-equals `[]`,
   `proposedPaths` deep-equals `['src/notes.mjs']`; stages < cap; disk keeps
   stage-1 content.
2. **single no-op stage gets the nudge, does NOT auto-complete** — plan; stage 1
   writes `src/a.mjs`; stage 2 no-op patch (streak=1); stage 3 writes new
   `src/b.mjs` (resets); stage 4 emits STAGED_DONE to exit. Assert `implement-2`
   has `noProgress === true`, `writeCount === 0`, no `implicitDone`; stage-3
   request body contains the corrective nudge text (via `server.recordings`);
   `src/b.mjs` exists; no `StagedIncompleteError`.
3. **no-op patches with NO prior real write do not false-complete** — plan; stage
   1 and stage 2 both no-op patch a pre-created file (`allWrites.length === 0`).
   Assert `staged.done === false`; no `implicitDone`; falls to
   `StagedIncompleteError` (`summary.writeError.name === 'StagedIncompleteError'`).
4. **phase-224 regression: steer arm still auto-completes** — plan; stage 1
   writes new `src/answer.mjs`; stage 2 re-writes via `files[]` → `SafeWriteError`
   → `safeWriteSteer`; stage 3 zero proposed paths, no STAGED_DONE → phase-224
   implicitDone. Assert `implement-2.safeWriteSteer === true`,
   `implement-3.implicitDone === true`, `staged.done === true`, no
   `StagedIncompleteError`, disk keeps stage-1 content, and the rename regression:
   `implement-2.appliedPaths` deep-equals `[]`, `proposedPaths` deep-equals
   `['src/answer.mjs']`.

Keep the phase-216 and phase-224 blocks intact and green.

## Done criteria

- [x] Successful-apply block split on `writeResult.writes.length`; zero-applied
      stage increments `noProgressTurns`, appends corrective scratchpad, and
      auto-completes (implicitDone/done/break) on the second consecutive
      zero-applied stage gated by `allWrites.length > 0`; real-write branch
      unchanged (resets `noProgressTurns` + `safeWriteSteered`).
- [x] N=2, justified.
- [x] Stage records expose `proposedPaths` + `appliedPaths` + `writeCount`.
- [x] Phase-224 steer arm + tests stay green; no change to `tool-calls.mjs` /
      `safe-writes.mjs`.
- [x] New Phase 225 describe block (four cases), scripted fake-model only,
      including false-completion guard (case 3) and phase-224 regression (case 4).
- [x] `npm run format` clean. Full suite passes. `npm run check` clean.
- [x] `process/decisions.jsonl` entry (rule, N=2, `allWrites.length > 0` gate,
      `noProgressTurns` reuse, forensics rename, rationale; reference
      `failures.jsonl` `224-dogfood`).
- [x] Blog `blog/225-stage-auto-advance-zero-applied-writes.md`.
- [x] NEXT.md FIFO: delete the shipped "Stage auto-advance on zero *applied*
      writes (no-op patch stall)" candidate; update the frontier note.
- [x] `roadmap.md`: `- [x] 225 Stage Auto-Advance on Zero Applied Writes`.
- [ ] Commit (small, focused; do not push).

## Risks / things to watch

- **False completion** — mitigated by `allWrites.length > 0` (no prior real writes
  ⇒ never auto-complete; falls to `StagedIncompleteError`) and N=2. Cases 2 and 3
  guard it.
- **Streak coherence:** a real applied write must reset `noProgressTurns` so
  `write → no-op → write → no-op` never accumulates. Case 2 covers it.
- **No phase-224 regression:** the steer arm keys on a throw; the zero-applied
  branch on a non-throw — mutually exclusive. Case 4 re-asserts the steer path.
- **`StagedUnverifiedError`** must still surface; `summary.ok`/`staged.done` parity
  with explicit STAGED_DONE.
- **Forensics rename blast radius:** keep a `paths` alias if any consumer surfaces.
- **Inter-stage install** must not run on a zero-applied stage (the `continue`
  makes this explicit).
