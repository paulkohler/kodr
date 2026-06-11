# js-rename-function

## Task

Rename `processItem` to `transformItem` everywhere: `src/helpers.mjs`,
`src/main.mjs`, and `src/utils.mjs`.

## Planted defect

The test file already imports `transformItem` (the new name), but the source
files still export `processItem`. All three source files need updating.

## Assertions

- `tests_pass` — `node --test` exits 0 after the rename.
- `content_absent` on `src/helpers.mjs` for `/\bprocessItem\b/` — old name gone.
- `content_absent` on `src/main.mjs` for `/\bprocessItem\b/` — old name gone.
