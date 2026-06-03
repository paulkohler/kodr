# Phase 80: Subagent Stage Orchestration

## Goal

Extend Phase 58 staged execution by splitting plan, implementation, and review
into isolated model conversations. This keeps each stage's context smaller and
lets Kodr assign distinct roles, tools, prompts, and artifacts to each stage.

Activated with `--subagent-stages`.

## Design

Add a new orchestration path:

1. Build workspace context.
2. Run a planner agent with read-only tools.
3. Run an implementer agent with the planner's plan and standard Kodr proposal
   output.
4. Apply or dry-run the proposal through existing safe writes.
5. Run a reviewer agent with the plan and proposed writes.
6. Write `orchestration.json` and per-agent artifacts.

Each subagent gets a shared roster in its system prompt:

- `planner`: explores and writes a plan.
- `implementer`: follows the plan and emits a proposal.
- `reviewer`: checks the plan/proposal and may run tests.

User prompt lines prefixed with `planner:`, `implementer:`, or `reviewer:` are
routed to that agent as targeted instructions. Other prompt text is shared.

## Artifact Layout

```text
.kodr/runs/{runId}/
  orchestration.json
  subagents/
    planner/
      request.json
      response.md
      result.json
      messages.json
    implementer/
      request.json
      response.md
      proposal.json
      messages.json
    reviewer/
      request.json
      response.md
      result.json
      messages.json
```

## Non-Goals

- No automatic reviewer repair loop.
- No multi-round plan critique.
- No separate model selection per agent yet.

## Done Criteria

- [x] Add `--subagent-stages` and make it imply tools.
- [x] Add `src/orchestration.mjs`.
- [x] Add planner, implementer, and reviewer prompts.
- [x] Planner, implementer, and reviewer artifacts are written separately.
- [x] Reviewer failures are surfaced without throwing.
- [x] Tests cover directive routing, prompt roster injection, individual agents,
      and full orchestration.
- [x] Update docs, decisions, and blog.
- [x] Run format, tests, and check.
- [x] Mark roadmap complete and commit.
