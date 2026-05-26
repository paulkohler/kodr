# Phase 19: Task Planning

## Goal

Add a small task-list planning primitive so Kodr can make work state explicit before coding and verification.

## Scope

- [x] Represent tasks with stable ids, descriptions, status, and optional notes.
- [x] Build an initial task list from a prompt and expected file paths.
- [x] Update task status from proposal and verification outcomes.
- [x] Include task plans in workflow primitives.
- [x] Persist task plans in run artifacts.
- [x] Expose bounded tools for listing and updating task status.

## Done Criteria

- [x] Native tests cover task creation and status updates.
- [x] `koder run` writes `tasks.json`.
- [x] Run summaries reference the task artifact.
- [x] Tool tests cover task list and update calls.
- [x] Blog post documents why task lists belong in the harness.
