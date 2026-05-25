# Phase 06: Context Packing

## Goal

Build deterministic workspace context for prompts.

## Build Steps

- [ ] Add deterministic file walker.
- [ ] Ignore `.git`, `.koder`, `node_modules`, and build outputs.
- [ ] Filter binary files.
- [ ] Add per-file and total byte budgets.
- [ ] Add `--show-files` and `--show-context`.

## Done Criteria

- [ ] Tests prove deterministic ordering.
- [ ] Tests prove ignore behavior.
- [ ] Blog post explains context as an inspectable input.
