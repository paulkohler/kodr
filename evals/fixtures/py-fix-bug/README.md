# py-fix-bug

## Task

Fix the bug in `src/calc.py` so the tests pass.

## Planted defect

`multiply` returns `a + b` instead of `a * b`. `multiply(3, 4)` returns 7, but
the test expects 12.

## Assertions

- `tests_pass` — `python3 -m unittest discover` exits 0 after the fix.
- `file_modified` on `src/calc.py` — the bug must be fixed in the source.

## Requires

`python3` — skipped on machines without Python 3.
