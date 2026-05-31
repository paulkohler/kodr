# Phase 58: Staged Complex Execution

## Goal

Prevent complex local-model coding runs from succeeding after one giant
proposal. Kodr should plan first, then apply bounded implementation slices with
fresh context between slices.

## Context

The Nemotron Postgres documents API run proved the timeout fix worked, but also
showed a second harness gap: the model produced a single 15-file response with
large hidden reasoning, incomplete tests, and stale README instructions. The
existing task plan was written after the response, so it recorded the outcome
but did not shape model behavior.

## Scope

- Add a `--staged` run flag and `--no-staged` escape hatch.
- Automatically stage complex `--tools --yes` runs that mention service/API
  work, dependencies, Docker, databases, migrations, or tests.
- Add a plan-only model turn before implementation.
- Apply implementation in bounded slices, with a maximum number of touched paths
  per stage.
- Refresh workspace context between implementation stages.
- Mark the run incomplete if the stage budget is exhausted before the model
  explicitly reports completion.
- Record staged execution details in run artifacts.

## Done Criteria

- [x] CLI parsing covers `--staged` and `--no-staged`.
- [x] Complex applied tool runs auto-enter staged execution.
- [x] Staged runs include a plan turn before implementation turns.
- [x] Each implementation turn is capped to a small path count.
- [x] Context is rebuilt between implementation turns.
- [x] Run artifacts record stage metadata and incomplete staged runs fail.
- [x] Tests cover staged execution.
- [x] Blog and process logs capture the learning from the Nemotron run.
