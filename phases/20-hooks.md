# Phase 20: Hooks

## Goal

Add deterministic lifecycle callbacks that can observe, mutate, or block model-facing operations without relying on the model to remember policy.

## Scope

- [x] Add a small hook registry with ordered async handlers.
- [x] Support pre-tool-use and post-tool-use events.
- [x] Allow pre-tool hooks to mutate tool input or block the call.
- [x] Record hook decisions in hook results and blocking errors.
- [x] Keep hooks dependency-free and explicit.

## Done Criteria

- [x] Native tests cover handler order, mutation, blocking, and post-tool observation.
- [x] `ToolRunner` uses hooks around tool calls.
- [x] Blog post explains why hooks are separate from model instructions.
