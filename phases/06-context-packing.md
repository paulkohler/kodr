# Phase 06: Context Packing

## Goal

Build deterministic workspace context for prompts.

## Build Steps

- [ ] Add deterministic file walker.
- [ ] Ignore `.git`, `.koder`, `node_modules`, and build outputs.
- [ ] Filter binary files.
- [ ] Add per-file and total byte budgets.
- [ ] Detect root `AGENTS.md`.
- [ ] Include `AGENTS.md` content in the system prompt section.
- [ ] Add `--show-files` and `--show-context`.

## Done Criteria

- [ ] Tests prove deterministic ordering.
- [ ] Tests prove ignore behavior.
- [ ] Tests prove `AGENTS.md` is included as instruction context.
- [ ] Blog post explains context as an inspectable input.
