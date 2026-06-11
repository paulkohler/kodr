# js-fix-failing-test

## Task

Fix the bug in `src/math.mjs` so the tests pass.

## Planted defect

`add` returns `a + b + 1` instead of `a + b`. This causes `add(2, 3)` to return 6
instead of 5, failing every `add` assertion in the test.

## Assertions

- `tests_pass` — `node --test` must exit 0 after the fix.
- `file_modified` on `src/math.mjs` — the bug must be fixed in the source file.
- `file_unchanged` on `test/math.test.mjs` — tests must not be edited to make the suite pass.
