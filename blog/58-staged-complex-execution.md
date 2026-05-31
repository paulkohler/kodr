# Phase 58: Staged Complex Execution

The second Nemotron Postgres API run was valuable because it succeeded in the
transport sense and failed in the harness sense.

The model produced one large response: a plan hidden in reasoning, then fifteen
full-file writes. Kodr applied them and marked the run successful because the
JSON envelope was valid and the file writes landed. The generated app was still
clearly incomplete: only a health test existed, the README referenced a missing
migration script, and the test used an assertion API that `node:test` does not
provide.

That exposed the difference between recording a task plan and using a task plan
to steer execution. `tasks.json` was useful after the fact, but it did not force
the model to plan, implement, inspect, test, and repair.

Phase 58 adds a staged path for complex work. Applied tool runs that look like
service/API/database/dependency tasks now start with a plan-only turn. The
implementation then proceeds in small slices, with a cap on touched paths and
fresh context between stages. A staged run is not considered successful unless
the model explicitly reaches `STAGED_DONE`, or verification proves the work.

This keeps simple runs simple, but prevents the harness from treating one giant
local-model proposal as a completed complex app.

The first staged Nemotron retry exposed a second staging bug. The model produced
a good plan, then returned a no-op implementation turn with `files: []` while
claiming the stage was complete. Kodr failed the run, which was better than a
false positive, but it stopped too early and reported the applied run as
`dry-run`.

Staged execution now treats no-op implementation turns as corrective feedback
for the next stage. The next prompt explicitly says no files changed and asks
for concrete files or patches. The stage budget is also derived from
`--max-turns` with a cap, so a user who gives a slow local model a larger turn
budget gets more staged attempts.
