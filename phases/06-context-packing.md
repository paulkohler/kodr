# Phase 06: Context Packing

## Goal

Build deterministic workspace context for prompts.

## Build Steps

- [x] Add deterministic file walker.
- [x] Ignore `.git`, `.koder`, `node_modules`, and build outputs.
- [x] Filter binary files.
- [x] Add per-file and total byte budgets.
- [x] Detect root `AGENTS.md`.
- [x] Include `AGENTS.md` content in the system prompt section.
- [x] Add `--show-files` and `--show-context`.

## Done Criteria

- [x] Tests prove deterministic ordering.
- [x] Tests prove ignore behavior.
- [x] Tests prove `AGENTS.md` is included as instruction context.
- [x] Blog post explains context as an inspectable input.
