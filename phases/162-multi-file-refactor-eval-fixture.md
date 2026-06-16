# Phase 162: Multi-File Refactor Eval Fixture

## Motivation

The brownfield eval suite measured single-defect fixes (one broken function, one
wrong file). The NEXT.md item "Multi-file refactor eval fixture" asked for a case
where the model must coordinate changes across two files with an import/export
dependency — specifically to measure plan-manifest/file-author composition.

The existing `js-rename-function` case touches three files, but it is a
mechanical text substitution with no structural dependency. A module-extraction
refactor is harder: the model must:
1. **Create** a new file (`src/utils.mjs`) that did not exist before.
2. **Update** an existing file (`src/string-ops.mjs`) to import from the new one.
3. Keep the import path correct and the interface consistent with the tests.

## What this phase does

**New fixture: `evals/fixtures/js-extract-module/`**:
- `src/string-ops.mjs`: two functions (`formatName`, `formatTitle`) that both
  implement the same title-casing logic — deliberate duplication.
- `test/string-ops.test.mjs`: imports `toTitleCase` from `src/utils.mjs`
  (not yet created) and tests it both standalone and via `formatTitle`. Baseline
  fails with `ERR_MODULE_NOT_FOUND` (confirmed).

**`evals/brownfield.json`**:
- Added `js-extract-module` case: `expectFailingBaseline: true`,
  `tests_pass + files_exist + content_matches` assertions.

**`test/eval.test.mjs`**:
- Two new tests: suite includes the case with required assertions; fixture
  baseline actually fails.

## Done criteria

- [x] `evals/fixtures/js-extract-module/{src/string-ops.mjs, test/string-ops.test.mjs, README.md}`
- [x] `js-extract-module` case in `evals/brownfield.json` (9 cases total).
- [x] Baseline confirmed failing (`ERR_MODULE_NOT_FOUND`).
- [x] 2 new eval tests; suite 1550 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
