# Phase 225: Stage Auto-Advance on Zero Applied Writes

Phase 224 closed the `files[]`-vs-existing `SafeWriteError` stall. A live dogfood
run against qwen3.6 immediately found the sibling case it left open.

## The stall phase 224 could not reach

The run was an Express + SQLite notes API — staged execution, `--install`,
`--test`. Stage 1 wrote four files. Stage 2 fixed two real bugs with `edit_file`
patches. Stages 3 through 7 were the problem: the model re-read the files, decided
they were correct, and looped on rejected `run_command` calls (`npm install`,
`node --test`). Each of those stages produced a proposal that *claimed* a path
(`patches: [{path: "src/server.mjs", search: "...", replace: "..."}]`), but the
`search` string no longer matched anything in the already-correct file, so
`prepareChanges` produced `failedPatches` and zero `writes`. `writeResult.writes`
was empty.

Phase 224's arm looks at `safeWriteSteered` — did a `files[]`-vs-existing
`SafeWriteError` fire earlier? It did not. The model used `edit_file` patches, not
`files[]` overwrites, so no `SafeWriteError` and `safeWriteSteered` stayed false.

The `paths.length === 0` no-progress branch also never fired, because the proposal
still *claimed* the path. `paths` was `['src/server.mjs']`, not empty.

So the harness saw: no error thrown, `paths.length > 0`, `writeResult.writes.length
=== 0`. It pushed the stage record as a normal progress stage, reset nothing, and
continued. Seven stages consumed; `staged.done: false`; `ok: true` only because the
tests happened to pass before the budget ran out.

## The fix: key no-progress on *applied* writes

The diagnosis was clean: the harness checked the *wrong thing* to detect no
progress. Proposed paths are the model's claim; applied writes are what actually
happened. A stage where `writeResult.writes.length === 0` is a no-progress stage,
regardless of how many paths the proposal claimed.

The fix splits the successful-apply block on `writeResult.writes.length`:

**Zero-applied-write branch**: the proposal claimed paths but nothing was written.
Increment `noProgressTurns`. Append a corrective scratchpad nudge ("No-progress
feedback: implementation stage N made no file changes. Correct that now..."). If
`noProgressTurns` has now reached 2 AND `allWrites.length > 0`, set `done = true`
and break with `implicitDone`. Otherwise `continue` to the next stage.

**Real-write branch**: existing flow, unchanged. Push `allWrites`, reset
`noProgressTurns` and `safeWriteSteered`, push the stage record.

## N=2, not N=1

The `noProgressTurns > 0` prompt arm already nudges on the first zero-applied
stage. N=1 would pre-empt a model that legitimately re-reads in one stage and
writes in the next. N=2 means one nudge, then break if the *next* stage is still
zero-applied — the model ignored the nudge. This matches the phase-224
second-consecutive-steer arm and the `>= 2` thresholds already used in
`watcher.mjs` and `healing.mjs`. The existing `noProgressTurns` counter is reused —
a zero-applied-write stage is semantically the same no-progress event as a
zero-proposed stage, and one counter (reset on every real write) is safer than two.

## The `allWrites.length > 0` gate

If no real writes have landed anywhere in the run, auto-completing would silently
discard a run that simply failed to write anything. The gate ensures `implicitDone`
only fires when real progress happened first — everything after was polish the model
got wrong. Without the gate, a run that emits two consecutive no-op patches from
stage 1 (before anything has been written) would complete silently instead of
surfacing `StagedIncompleteError`.

## Forensics: proposed vs applied paths

The stage record used to carry a bare `paths` key showing the proposal's claimed
paths. On a zero-write stage this was actively misleading — it looked like something
was targeted, not like a no-op. The rename adds `proposedPaths` (what the model
claimed) and `appliedPaths` (what was actually written, which may be empty). All
affected records — the successful-apply block, the phase-224 steer arm, and the
zero-proposed-paths arm — now use the explicit pair. No production consumer read
`stages[].paths`; the existing phase-216/224 tests checked `.noProgress`,
`.safeWriteSteer`, and `.implicitDone`, not `.paths`, so the rename was clean.

## Three no-progress paths, mutually exclusive

After this phase, `runStagedPrompt` has three distinct no-progress paths:

1. **Zero proposed** (`paths.length === 0`): before `prepareChanges`, the model
   returned no files or patches. `continue`/`break` based on `safeWriteSteered`.
2. **`SafeWriteError` steer** (phase 224): `prepareChanges` throws because a
   `files[]` entry targets an existing path. First throw steers; second throw is
   `implicitDone`.
3. **Zero applied** (this phase): `prepareChanges` succeeded but produced no
   writes. After two consecutive such stages with prior real writes, `implicitDone`.

A real applied write resets both `noProgressTurns` and `safeWriteSteered`, so a
`write → no-op → write → no-op` sequence never accumulates a false streak.

## Tests

Four new cases in `test/app.test.mjs`, all scripted fake-model only, none emitting
`STAGED_DONE` for the auto-complete cases:

1. **Two consecutive no-op patches auto-complete** — verifies `staged.done === true`,
   `implement-3.implicitDone === true`, `writeCount === 0`, `appliedPaths === []`,
   `proposedPaths === ['src/notes.mjs']`, disk keeps stage-1 content.

2. **Single no-op patch gets the nudge, does not auto-complete** — verifies
   `implement-2.noProgress === true`, `writeCount === 0`, no `implicitDone`;
   stage-3 request body contains the corrective nudge text; `src/b.mjs` exists;
   no `StagedIncompleteError`.

3. **No-op patches with no prior real write do not false-complete** — verifies
   `staged.done === false`, no `implicitDone` anywhere, falls to
   `StagedIncompleteError`.

4. **Phase-224 regression: steer arm still auto-completes** — verifies
   `implement-2.safeWriteSteer === true`, `implement-2.appliedPaths === []`,
   `implement-2.proposedPaths === ['src/answer.mjs']`, `implement-3.implicitDone
   === true`, `staged.done === true`, disk keeps stage-1 content.

Test count moved from 1804 to 1808.
