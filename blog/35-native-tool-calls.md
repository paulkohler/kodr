# Phase 35: Native Tool Calls

Phase 35 adds OpenAI-compatible function calling to the harness. Where phase 11's
ReAct loop parsed tool invocations out of model text, this phase uses the
`tools`/`tool_calls` protocol natively: the model receives a typed tool schema,
signals intent with `finish_reason: "tool_calls"`, and the harness dispatches,
collects results, and continues.

## What changed

`src/tool-calls.mjs` is a new module alongside the existing `tools.mjs`. The
two paths are kept separate deliberately — one is text-based ReAct, the other is
structured function calling. Mixing them would obscure the contrast that makes
each one interesting to study.

**`ToolRegistry`** maps tool names to `{ description, parameters, handler }`
entries. `toApiTools()` builds the `tools` array the API expects. `dispatch()`
parses the model-supplied argument JSON and calls the handler.

**`completeWithToolCalls`** runs the multi-turn loop:

1. Send the request with the full `tools` array.
2. If `finish_reason === "tool_calls"`, append the assistant message (with
   `tool_calls` intact — the API requires this in history) and dispatch each call.
3. Append a `role: "tool"` message per result, keyed by `tool_call_id`.
4. Repeat until any non-`tool_calls` finish reason.

Each tool-call round counts as a budget turn (not a retry). Retries are for
`finish_reason: "length"` continuations; tool rounds are real model calls.

**`--tools` flag** in `kodr run` swaps `completeWithContinuations` for
`completeWithToolCalls` with the built-in registry (`list_files`, `read_file`).

## Security notes in the code

Two comments in the implementation flag the key risks:

- **Argument parsing**: model-supplied `arguments` strings are treated as
  untrusted. Non-JSON and non-object payloads are rejected before the handler
  runs.
- **Path traversal**: `read_file` runs the path through `jailedPath` before any
  filesystem access. A model handing back `"../../etc/passwd"` gets a rejection,
  not a read.

Errors from handlers are returned as `{ "error": "..." }` content rather than
thrown. This lets the model observe the failure and potentially recover; it also
means the loop doesn't die on a bad tool call.

## Live test results

Both models handled `--tools` correctly on the first attempt.

**gpt-5.4-nano via OpenRouter** (`list_files` → stop): called `list_files`,
then returned a structured proposal with an info-level message summarising the
workspace. Two turns.

**qwen/qwen3.6-35b-a3b local** (`list_files` → stop): called `list_files`,
then produced a detailed Markdown table covering all directories, phases, and
examples. Two turns. Response was noticeably richer — the model used the file
list to infer structure rather than just echo it.

## Version check fix

Adding phases 35–38 to the roadmap as unchecked items immediately broke the
`cversion` check because `roadmapVersion` counted all phase lines regardless of
`[x]` vs `[ ]`. Fixed to match only `[x]` lines, so the version tracks completed
milestones rather than the planning horizon.
