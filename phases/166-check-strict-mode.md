# Phase 166: `kodr check --strict`

## Motivation

`kodr check` exits 0 for advisory warnings (smoke-check failures, sensor warns)
and only fails on syntax errors. This is the right default for interactive use —
a sensor false-positive shouldn't block a commit. But CI pipelines and
pre-commit hooks often want stricter behaviour: if the cross-reference sensors
or smoke-check fire, the commit should be blocked.

## What this phase does

**`src/cli/args.mjs`**:
- Added `strict: false` to option defaults.
- Added `--strict` parse branch (sets `options.strict = true`).
- Updated `kodr check` usage line to include `[--strict] [--json]`.
- Added `--strict` help text.

**`src/commands/check.mjs`**:
- After all gates run, if `options.strict` is true: promote smoke-check
  `failed` status and any sensor `warn` result to `ok = false`.
- The `checkResult.ok` field and the ANSI footer both reflect this.
- `timeout` and `skipped` smoke statuses are not promoted — they are still
  inconclusive, not evidence of a code defect.

**`test/check-command.test.mjs`** — 2 new tests:
- `--strict` makes a sensor warn exit non-zero (result.ok false, output has
  "check failed").
- Without `--strict`, the same sensor warn leaves ok true.

## Done criteria

- [x] `--strict` promotes sensor warns and smoke `failed` to check failures.
- [x] `timeout`/`skipped` smoke statuses not promoted.
- [x] `--strict` + `--json` works (checkResult.ok reflects strict evaluation).
- [x] 10 check-command tests; suite 1570 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
