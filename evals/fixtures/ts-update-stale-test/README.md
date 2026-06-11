# ts-update-stale-test

## Task

The source `src/formatter.ts` was recently changed: `format` now returns
`s.trim().toUpperCase()`. Update `test/formatter.test.mjs` so its expectations
match the current behavior.

## Planted defect

The test expects `format(' Hello ')` to return `'hello'` (lowercase), but the
implementation now returns `'HELLO'` (uppercase). The source is correct; the
test expectations are stale.

## Notes

The test file imports `formatter.ts` directly. Node.js 24 strips types from
`.ts` source files at runtime so no `tsc` step is needed.

## Assertions

- `tests_pass` — `node --test` exits 0 after the test update.
- `file_unchanged` on `src/formatter.ts` — source must not be changed.
- `file_modified` on `test/formatter.test.mjs` — only the test should change.
