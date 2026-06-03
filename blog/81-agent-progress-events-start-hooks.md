# Phase 81: Agent Progress Events And Start Hooks

The Nemotron subagent example made a product gap obvious: the run was working,
but the terminal was silent while the local model generated. For small remote
models that is tolerable. For local multi-agent runs it feels broken.

Phase 81 adds structured progress events for normal and subagent stages. The TUI
can now print grey status lines such as planner started, implementer finished,
and reviewer finished. These are channel events, not TUI-specific hacks, so a
future web UI can consume the same stream.

The phase also adds `AgentStart` and `SubagentStart` command hooks. These run
before the model call, which makes them useful for deterministic logging or
policy checks that should block before token generation begins.

One boundary is explicit: Kodr does not surface hidden model reasoning. It
surfaces visible artifacts instead: the planner plan, reviewer summary, proposal
messages, and progress events.
