# Phase 55: Self-Dev — Registry Command

## Goal

Add a `kodr registry` subcommand that discovers which external inspectors are
available in the current environment and reports them.

Kodr edits its own `src/app.mjs` and `src/external-inspector-registry.mjs` to
wire the new command. This is the second self-development test.

## Behaviour

```
kodr registry [--json]
```

Without `--json`: prints a human-readable table, one inspector per line:
```
gopls              go           ✓ available
pyright            python       ✗ not found
rust-analyzer      rust         ✗ not found
typescript-language-server  javascript,typescript  ✗ not found
```

With `--json`: prints a JSON array:
```json
[
  { "name": "gopls", "languages": ["go"], "available": true },
  { "name": "pyright", "languages": ["python"], "available": false },
  ...
]
```

The command should check all entries in `REGISTRY` regardless of what languages
are in the current workspace.

## Done Criteria

- [ ] `kodr registry` command added to `src/app.mjs`.
- [ ] Help text updated in `app.mjs`.
- [ ] `--json` flag supported.
- [ ] Test in `test/` that invokes `main(['registry', '--json'], ...)` and
      asserts the result shape (array, each entry has `name`, `languages`,
      `available`).
- [ ] `npm run format` and `npm run check` pass.
- [ ] Decisions recorded.
- [ ] Roadmap marked complete and committed.

## Self-Dev Notes

This phase requires the model to understand the command dispatch pattern in
`app.mjs` and the registry exports in `external-inspector-registry.mjs`. If
the model duplicates the discovery logic instead of importing it, that is a
context-selection failure — update the inspect-context or prompt and retry.
