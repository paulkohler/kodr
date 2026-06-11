# js-fix-named-path

## Task

Fix `tests/utils.mjs` so `trimName` strips surrounding whitespace instead of
uppercasing its input.

## Planted defect

`trimName` returns `s.toUpperCase()` instead of `s.trim()`. The file lives at
`tests/utils.mjs` (note: the `tests/` directory, not `test/`). A model prone to
creating a root-level sibling instead of editing the named path will create
`utils.mjs` at the repo root, leaving the import broken.

## Assertions

- `tests_pass` — `node --test` exits 0.
- `file_modified` on `tests/utils.mjs` — the helper must be edited in place.
- `files_absent` for `utils.mjs` — no root-level sibling must be created.

This directly encodes the phase-58 postgres trial failure where Nemotron
created a root-level sibling instead of editing the named path.
