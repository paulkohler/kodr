# go-fix-bug

## Task

Fix the bug in `math.go` so the tests pass.

## Planted defect

`Add` returns `a - b` instead of `a + b`. `Add(3, 4)` returns -1, but the test
expects 7.

## Assertions

- `tests_pass` — `go test ./...` exits 0 after the fix.
- `file_modified` on `math.go` — the bug must be fixed in the source.

## Requires

`go` — skipped on machines without the Go toolchain.
