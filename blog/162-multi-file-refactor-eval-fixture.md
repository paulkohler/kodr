# Phase 162: Multi-File Refactor Eval Fixture

The eval suite measures single-defect fixes well. What it didn't measure:
cross-file refactors where the model must create a new file *and* update an
existing file to import from it.

`js-extract-module` is that fixture. The starting state:

- `src/string-ops.mjs` has two functions (`formatName`, `formatTitle`) that
  each inline identical title-casing logic.
- `test/string-ops.test.mjs` imports `toTitleCase` from `src/utils.mjs` — a
  file that does not exist yet.
- Baseline: `ERR_MODULE_NOT_FOUND`. The test suite fails before any test runs.

The model must:
1. Create `src/utils.mjs` with `export function toTitleCase(s)`.
2. Update `src/string-ops.mjs` so both functions import and delegate to it.

Assertions: `tests_pass`, `files_exist` for `src/utils.mjs`, `file_modified`
for `src/string-ops.mjs`, `content_matches` for `toTitleCase` in the new file
and for the word `utils` in the updated import.

`expectFailingBaseline: true` documents that the initial run is expected to
fail; the heal loop (or a direct model run with the full prompt) is what makes
it pass.

This fixture joins 8 others in `evals/brownfield.json` — 9 total — covering
JS syntax repair, ESM rewrite, missing-export repair, type annotation removal,
Promise-to-async conversion, test-alignment, config-key rename, dead-code
removal, and now multi-file extraction.
