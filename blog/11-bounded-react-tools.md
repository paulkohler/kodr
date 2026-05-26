# Phase 11: Bounded ReAct Tools

Phase 11 introduces tool primitives with strict limits.

## Decision

Add a `ToolRunner` that owns budget tracking and duplicate-call detection before any workflow loop can use tools.

## Tools

- `list_files`
- `read_file`
- `write_file`
- `run_command`
- `fetch_url`

`fetch_url` blocks local and private network targets. `run_command` reuses the verification allowlist, and `write_file` reuses controlled safe writes.

## Why Limits First

Tools amplify model mistakes. Budgets, duplicate detection, path jails, command allowlists, and network blocks must exist before tools are placed inside iterative loops.

## Verification

```sh
npm run format
npm test
npm run check
```
