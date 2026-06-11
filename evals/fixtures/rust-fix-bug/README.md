# rust-fix-bug

## Task

Fix the bug in `src/lib.rs` so the tests pass.

## Planted defect

`multiply` returns `a + b` instead of `a * b`. `multiply(3, 4)` returns 7 but
the test expects 12.

## Assertions

- `tests_pass` — `cargo test` exits 0 after the fix.
- `file_modified` on `src/lib.rs` — the bug must be fixed in the source.

## Requires

`cargo` — skipped on machines without the Rust toolchain.
