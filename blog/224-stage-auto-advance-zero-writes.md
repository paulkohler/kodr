# Phase 224: Stage Auto-Advance on Zero New Unique Writes

The staged pipeline has had a persistent failure mode: when all target files are
already written and a verification stage begins, the model has nothing left to
apply but the loop still runs. It grinds through the remaining stage budget and
exits with `StagedIncompleteError`. Phase 223 tried to fix this by embedding a
`STAGED_DONE` JSON envelope in the sentinel tool-error message. That did not work.

## The Phase-223 failure

After phase-223 shipped, dogfooding confirmed that qwen3.6 ignores completion
hints buried in tool-result error messages. The model treats a tool error as a
retry signal: it reads the error, decides the tool call failed, and loops back
to try again. The embedded `STAGED_DONE` envelope was never heeded. All three
dogfood runs ended in `StagedIncompleteError` with 7 stages consumed.

The failure is recorded in `process/failures.jsonl` (phase-223-staged-completion):
the model "continues making tool calls (write_file/edit_file) instead of
returning the completion envelope."

## The mechanical fix

Phase 224 takes a different approach: ignore the model entirely. The harness
tracks whether a `safeWriteSteer` has fired during the current run using a new
`safeWriteSteered` boolean flag. When the flag is set and the *next* stage
produces zero writes, the harness concludes the model has nothing new to apply
and sets `done = true` with an `implicitDone` record. No model cooperation
required.

The two trigger conditions:

1. **Prior steer + zero-write stage**: `safeWriteSteered === true` and the stage
   returns `paths.length === 0` without `STAGED_DONE`. The model returned an empty
   stage after being steered — implicit completion.

2. **Second consecutive `SafeWriteError`**: `safeWriteSteered === true` when a
   second `SafeWriteError` fires. The model keeps re-emitting `files[]` for
   already-existing paths and will never converge.

The flag resets to `false` whenever a stage applies at least one real write
(`noProgressTurns = 0` point). This means a sequence like write → steer → write
→ steer never false-completes — only consecutive steered/zero stages trigger it.

Stage-1 `SafeWriteError` remains fatal (the `stageIndex > 1` guard is unchanged),
so the phase-216 test stays green.

## `implicitDone` in stage records

When the harness triggers implicit completion, it pushes a stage record with
`implicitDone: true`. This is additive — it adds no new summary fields and does
not change how `staged.done` or `summary.ok` are computed. A run that reaches
implicit completion and applied writes earlier but ran no test still surfaces
`StagedUnverifiedError`, same as explicit `STAGED_DONE`. Forensics treat both
completion paths identically.

## Tests

Four new cases in the phase-216-style describe block, scripted fake-model only:

1. Steer → zero-write → `implicitDone`: verifies `staged.done === true`,
   `implement-3.implicitDone === true`, stage-1 content preserved on disk.
2. Two consecutive steers → `implicitDone` on the second: verifies
   `implement-2.safeWriteSteer === true`, `implement-3.implicitDone === true`.
3. Write between steers resets flag: stage 4 is `noProgress: true`, not
   `implicitDone`, and `src/b.mjs` exists.
4. Zero-write with no prior steer → `noProgress: true`, no `implicitDone`.

None of the four test cases emit `STAGED_DONE`. Completion in cases 1 and 2 must
come from the harness alone. Cases 3 and 4 pin the unchanged paths.

## What this closes

The live open problem from phase-223 dogfooding: "when every target file is
already written and a verification stage begins, the model has nothing left to
`write_file` and loops to budget exhaustion (`StagedIncompleteError`)." That
loop now terminates as soon as the harness observes a prior steer and either a
zero-write stage or a second consecutive `SafeWriteError`.

## Dogfooding: a sibling stall the fix does *not* catch

A live run against qwen3.6 (Express + SQLite notes API, staged + `--install` +
`--test`) showed the limit of this fix. The model wrote all four files in stage
1, fixed two real bugs with `edit_file` **patches** in stage 2, then in stages
3–7 re-read the files, judged them correct, and looped on rejected `run_command`
calls. Crucially it never threw a `SafeWriteError` — using `edit_file` patches on
existing files is exactly right — so `safeWriteSteered` stayed `false` and
phase-224's arm never fired. Each of stages 3–7 recorded `applied:true` but
`writeCount:0` (no-op patches), and because the proposal still *claimed* paths
the `paths.length===0` branch never fired either. The run ground to the 7-stage
budget and only ended `ok:true` because the tests happened to pass first
(`staged.done:false`).

So phase 224 closes the `files[]`-vs-existing variant but not the no-op-patch
variant. The lesson — recorded in `process/failures.jsonl` (224-dogfood) and
queued as the top NEXT.md candidate — is to key no-progress on *applied* writes
(`writeResult.writes.length === 0`), not on proposed `paths.length`. That
generalization is phase 225.
