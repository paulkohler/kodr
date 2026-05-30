# Phase 54: Self-Dev — Inspect Output Totals

## Goal

Kodr edits its own source code. This micro-phase is the first self-development
test: can the local model read `src/code-inspector.mjs`, understand the
`inspectWorkspace` return shape, and add two aggregate fields without breaking
existing tests?

## What to Add

Add `totalFiles` and `totalSymbols` integer fields to the object returned by
`inspectWorkspace`:

```js
{
  files: [...],
  languages: { go: 2 },
  references: [],
  symbols: [...],
  totalFiles: 2,        // ← new
  totalSymbols: 7,      // ← new
}
```

Both values are derivable from the existing `files` and `symbols` arrays — no
new data is needed.

## Done Criteria

- [ ] `inspectWorkspace` returns `totalFiles` equal to `index.files.length`.
- [ ] `inspectWorkspace` returns `totalSymbols` equal to `index.symbols.length`.
- [ ] Existing tests in `test/code-inspector.test.mjs` still pass.
- [ ] New assertion added to `test/code-inspector.test.mjs` or
      `test/inspect-command.test.mjs` that checks both new fields.
- [ ] `npm run format` and `npm run check` pass.
- [ ] Decisions recorded.
- [ ] Roadmap marked complete and committed.

## Self-Dev Notes

This phase is run by Kodr itself against the local model. If the model edits
the wrong file, adds the fields in the wrong place, or breaks existing tests,
that is a harness or prompt failure — diagnose and fix Kodr before retrying.
Do not patch the output manually.
