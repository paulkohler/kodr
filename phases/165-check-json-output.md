# Phase 165: `kodr check --json` Structured Output

## Motivation

`kodr check` outputs ANSI-coloured text designed for human reading. CI
integrations need to parse the result programmatically — checking which files
failed, how many sensors warned, or whether the smoke-check was skipped. Text
scraping is brittle; structured JSON is not.

## What this phase does

**`src/commands/check.mjs`** — refactored to separate data collection from
rendering:

1. All three gates (syntax, smoke-check, sensors) now write their results into
   a `checkResult` object (`{ ok, command, syntax, smokeCheck?, sensors? }`).
2. `renderAnsi(checkResult, fileCount, stdout)` — the existing ANSI renderer,
   now a pure function that consumes `checkResult`.
3. When `options.json` is truthy: skip the header, skip `renderAnsi`, print
   `JSON.stringify(checkResult, null, 2)` to stdout.

When `--no-smoke` is set, `checkResult.smokeCheck` is absent (not null). When
`--no-sensors` is set, `checkResult.sensors` is absent. Downstream consumers
can distinguish "gate skipped" from "gate ran and returned null" by checking
field presence.

**`test/check-command.test.mjs`** — 2 new tests:

- `--json` emits valid JSON with `ok` and `command` fields on a clean workspace.
- `--json` sets `ok: false` and includes `syntax.failures` on a syntax error.

## Done criteria

- [x] `--json` emits parseable JSON for both passing and failing workspaces.
- [x] ANSI output unchanged when `--json` is not set (all 6 prior tests pass).
- [x] 8 check-command tests; suite 1568 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
