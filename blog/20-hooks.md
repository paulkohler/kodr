# Phase 20: Hooks

Hooks are the deterministic layer around model behavior. Instructions can ask the model to follow policy, but hooks let the harness observe, mutate, or block operations before and after a tool call.

This phase adds a small hook registry with ordered async handlers. `pre_tool_use` handlers receive the requested tool payload and can allow it, mutate it, or block it with a reason. `post_tool_use` handlers observe the result after the tool implementation runs.

The first integration point is `ToolRunner`. That keeps hooks close to concrete effects: reads, writes, commands, network fetches, and task updates. This is deliberately smaller than a plugin system. Later permission policy can be built on top of hooks, but hooks themselves stay dependency-free and explicit.
