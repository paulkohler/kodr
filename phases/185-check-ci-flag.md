# Phase 185: `kodr check --ci` Convenience Flag

## Motivation

`kodr check --changed --strict` is the recommended CI gate command. Having two
flags to remember is one too many. `--ci` collapses them into a single flag that
communicates intent clearly: "run the CI-appropriate check."

## What this phase does

**`src/cli/args.mjs`**:
- Parses `--ci` and sets both `options.changed = true` and `options.strict = true`.
- Updated usage line to include `[--ci]`.
- Added `--ci` help text: "Shorthand for --changed --strict."

**`test/app.test.mjs`** — 3 new tests in `kodr check --ci shorthand (Phase 185)`:
- `--ci` sets `changed` and `strict`.
- `--ci` combines with `--deep`.
- `--changed --strict` still works independently.

## Done criteria

- [x] `--ci` sets `changed: true` and `strict: true`.
- [x] Combinable with `--deep` and other flags.
- [x] 3 new parseArgs tests; all pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
