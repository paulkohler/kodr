# Phase 81: Agent Progress Events And Start Hooks

## Goal

Make long local-model runs less opaque by emitting structured progress events
from standard and subagent runs, and by adding start hooks that can log or block
before tokens are spent.

## Design

Add two surfaces:

- Internal progress events, delivered through the shared channel options as
  `onProgress(event)`.
- Command-backed lifecycle hooks for `AgentStart` and `SubagentStart`.

The TUI renders progress events as grey info messages. CLI runs stay quiet unless
a future channel wants to opt in.

Start hooks run before the model call. A block prevents the model call and
returns the hook reason through the normal run failure path.

## Events

- `agent_start`
- `agent_finish`
- `subagent_start`
- `subagent_finish`

Events include `agent`, `model`, `runDir`, timestamp, and finish metadata such as
duration and response character count when available.

## Reasoning Boundary

Kodr does not expose hidden model reasoning. It surfaces model-visible artifacts:
planner output, proposal messages, reviewer summaries, progress events, and tool
observations.

## Done Criteria

- [x] Add progress callback support for normal agent runs.
- [x] Add progress callback support for subagent runs.
- [x] Add `AgentStart` and `SubagentStart` command hook support.
- [x] TUI renders progress events as grey info lines.
- [x] TUI surfaces planner/reviewer summaries from subagent runs.
- [x] Tests cover hook events, progress callbacks, and TUI rendering.
- [x] Update usage docs, decisions, blog, roadmap, and version.
- [x] Run format, tests, and check.
- [x] Commit the phase.
