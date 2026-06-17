# Phase 170: `kodr check [dir]` Path Argument

## Motivation

`kodr check` always scans `cwd`. When running from a monorepo root or a CI
script that invokes kodr from a fixed location, you need to check a specific
subdirectory without `cd`-ing first.

## What this phase does

**`src/cli/args.mjs`**:
- Added `check` to the positionals routing block: when `command === 'check'` and
  `positionals.length === 2`, stores `positionals[1]` as `options.checkDir`.
- Updated usage line: `kodr check [dir] [--no-smoke] [--no-sensors] [--strict] [--json]`.

**`src/app.mjs`**:
- Added `resolve` to the `node:path` import.
- Before dispatching to `runCheck`, when `options.checkDir` is set, creates a
  patched `checkIo` with `cwd` resolved against `io.cwd`. When absent, passes
  `io` unchanged (backwards compatible).

**`test/app.test.mjs`** — 2 new tests:
- `parseArgs(['check', '/some/dir'])` stores `checkDir: '/some/dir'`.
- `parseArgs(['check'])` leaves `checkDir` undefined.

## Done criteria

- [x] `kodr check /path/to/dir` resolves the path and passes it to `runCheck`.
- [x] `kodr check` (no arg) unchanged.
- [x] `kodr check evals/fixtures/js-extract-module` works end-to-end.
- [x] 1591 tests green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
