# Phase 64: Patch Planning From Inspection

## Goal

Use inspection results to create better pre-edit plans.

The harness should identify likely target files, relevant symbols, nearby tests,
and verification commands before asking the model to produce patches. This
front-loads the navigation small local models are weakest at.

## Design

Add a **deterministic** planning step (no model call, so it is unit-testable)
that produces:

- target files
- target symbols
- related tests
- risk notes
- suggested verification commands

Reconcile this with the existing planning machinery rather than building a
parallel structure: extend `src/task-plan.mjs` (`createTaskPlan`,
`updateTasksFromRun`) so the inspection-derived plan becomes/augments a task-plan
artifact.

Suggested verification commands must be drawn from the existing allowlist in
`src/verification-runner.mjs` (`parseVerificationCommand`) — emitting a command
the runner rejects would mislead the model.

### Dependency: workflow turn-to-turn forwarding

Phase 57's scratchpad is currently only injected via the explicit
`--prior-scratchpad` flag into `runPrompt`; it is **not** auto-forwarded inside
the `workflow.mjs` / `cycles.mjs` loops. For a plan to actually reach the model
on the editing turn, this phase must wire that forwarding (plan + scratchpad)
into the workflow loop. This forwarding is also the foundation Phase 72 builds
on.

## Non-Goals

- No automatic patch generation changes unless needed for the plan artifact.
- No external inspector integration.
- No semantic type analysis.

## Done Criteria

- [ ] Add a deterministic inspection-derived plan artifact (extends
      `task-plan.mjs`).
- [ ] Include target symbols and related tests when available.
- [ ] Suggested verification commands are restricted to the allowlist.
- [ ] Auto-forward the plan + scratchpad across workflow turns (no flag needed).
- [ ] Add tests for plan generation and for turn forwarding (fake 2-turn model).
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
