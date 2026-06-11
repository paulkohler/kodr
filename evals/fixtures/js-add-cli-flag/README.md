# js-add-cli-flag

## Task

Add a `--version` flag to `src/cli.mjs`. When `--version` is passed, `parseArgs`
should return `{ version: true, versionString: VERSION }`.

## Planted defect

The CLI only handles `--help`. The pre-written test in `test/cli.test.mjs`
describes the `--version` feature as the specification; the tests currently fail
because `--version` is not yet implemented.

## Assertions

- `tests_pass` — `node --test` exits 0 after adding the flag.
- `file_modified` on `src/cli.mjs` — implementation must land in the CLI source.
