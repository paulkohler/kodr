# Phase 06: Context Packing

Phase 06 makes workspace context deterministic and inspectable.

## Decision

Build context locally from the workspace, include root `AGENTS.md` as instruction context, and expose `--show-files` plus `--show-context` before relying on context in model calls.

## Design

The packer walks files in sorted order, ignores generated or external directories, filters binary-looking files, and enforces per-file and total byte budgets. `AGENTS.md` is separated from regular file context and placed into the system prompt as repository instructions.

`kodr run` now writes `context.md` next to `prompt.md`, `response.md`, `summary.json`, and `raw-response.json`.

## Why

Prompt behavior should be explainable after the fact. The context artifact and show commands make the model input visible before it is sent to a local model.

## Verification

```sh
npm run format
npm test
npm run check
```
