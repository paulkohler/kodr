# Phase 187: kodr check --watch --ci Combination

## Motivation

`--watch` and `--ci` are natural companions: continuously re-run the CI gate as
files change. The combination was never explicitly tested — both flags exist and
compose at the parser level, but no test exercised the watcher with
`changed: true, strict: true` active.

## What this phase does

- Added 4 tests to `test/check-command.test.mjs` under `runCheckWatch`:
  - Combination starts cleanly and exits on abort
  - Summary line renders on the initial pass with CI flags
  - Sensor warning in strict mode: watcher keeps running (result.ok stays true)
- No production code changes needed — `runCheckWatch` passes `watchOptions =
  { ...options, watch: false }` to `runCheck`, so `changed` and `strict` flow
  through naturally.

## Done criteria

- [x] `--watch --ci` combination exercised in tests.
- [x] Summary line renders correctly with CI flags.
- [x] Watcher keeps alive through strict-mode failures (loop doesn't abort on
  a failed check result — it re-runs on the next change).
- [x] Tests pass.
- [x] Committed.
