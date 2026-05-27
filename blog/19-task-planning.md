# Phase 19: Task Planning

The example-app trial made planning concrete. Kodr could generate and verify a small app, but the work was still only visible as a prompt, response, writes, and tests. That is enough for replay, but not enough for longer runs where the harness needs to know what it believes is done, blocked, or still pending.

This phase adds a small task-plan primitive. A plan has stable task ids, descriptions, statuses, and optional notes. The first tasks are always to understand the request and inspect context. Proposed file paths become edit tasks. Verification and documentation are explicit tasks too.

`kodr run` now writes `tasks.json` next to the other run artifacts and includes `taskCounts` in `summary.json`. The task list is intentionally simple data instead of an interactive manager. That keeps it inspectable, replayable, and easy to feed into later workflow or repair loops.

The workflow primitive also now includes task plans, so staged work and todo-style planning describe the same run instead of living as separate concepts.

Kodr also exposes the same plan through bounded tools: `list_tasks` returns the current plan, and `update_task` changes a single task status with an optional note. That gives later ReAct loops a small task-management surface without inventing a separate planner UI.
