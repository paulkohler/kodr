# Phase 35: Native Tool Calls

## Goal

Replace the text-based ReAct tool loop (phase 11) with OpenAI-compatible function
calling. Models declare available tools via the `tools` request field; the harness
parses `tool_calls` from the response, dispatches the right function, injects a
`tool` role message, and continues the loop until the model returns a normal
assistant message.

This is the dominant agentic pattern in 2025 and a meaningful harness shape
change — worth learning explicitly alongside the text-parsing approach.

## Design

- Define a `ToolRegistry` that maps tool names to async handler functions.
- Build the `tools` array (JSON Schema descriptors) from the registry at call time.
- Extend `completeWithContinuations` (or a parallel function) to detect
  `finish_reason: "tool_calls"`, dispatch each call, and inject results as
  `tool` role messages before the next turn.
- Expose a small built-in tool set (e.g. `read_file`, `list_files`) so the loop
  can be exercised without a real task.
- Keep the existing text-based ReAct path intact — native tool calling is additive.
- Treat tool call arguments as untrusted (validate against schema before dispatch).
- Add an `--tools` flag to `kodr run` that enables the tool loop.

## Done Criteria

- [ ] `ToolRegistry` with schema-driven dispatch.
- [ ] `completeWithToolCalls` loop that handles multi-turn tool call rounds.
- [ ] At least two built-in tools exercised in tests.
- [ ] `--tools` flag wired into `kodr run`.
- [ ] Tests cover: single tool call, multiple tool calls in one turn, unknown tool
      error, loop terminates normally after tool use.
- [ ] Record decisions and any failures.
- [ ] Blog post.
