# Phase 80: Subagent Stage Orchestration

Phase 58 made complex work less brittle by splitting it into a plan turn and
bounded implementation turns. Phase 80 takes the next step: planner,
implementer, and reviewer are now separate model conversations.

The important difference is isolation. The planner can explore the workspace and
produce a concise plan. The implementer receives that plan and emits the normal
Kodr JSON proposal. The reviewer receives the plan and proposed writes, and can
return a pass/fail review without applying anything itself.

Each agent prompt starts with the same roster, so users can target a stage with
plain prompt prefixes such as `reviewer: run tests after`. Kodr strips those
directives from the shared prompt and injects them only into the matching
agent's user turn.

The first version is deliberately one pass. Reviewer failures are surfaced in
the run result and artifacts, but Kodr does not yet loop back into a repair
agent. That keeps the phase testable while leaving a clear future extension:
reviewer-driven repair orchestration.
