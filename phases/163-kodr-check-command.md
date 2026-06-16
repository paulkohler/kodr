# Phase 163: `kodr check` Command

## Motivation

The deterministic gates (syntax, smoke, cross-reference sensors) run inside
`kodr run` / `kodr tui` after writes are applied. They are not available as a
standalone diagnostic. If you want to check an existing project — before running
the model, as a CI gate, or just to inspect the workspace — there is no way to
invoke them directly.

## What this phase does

**New command: `kodr check [--no-smoke] [--no-sensors]`**

`src/commands/check.mjs`:
- Recursively collects all workspace files (excluding `node_modules`, `.git`,
  `.kodr`, `dist`, `build`, `.next`, `.nuxt`).
- Builds a synthetic writeResult covering all collected files.
- Runs the three gates in order:
  1. **Syntax gate** (`runSyntaxGateIfNeeded`) — checks all `.mjs`/`.cjs`/`.js`
     files; fails the command on parse error.
  2. **Smoke-check** (`runSmokeCheckIfNeeded`) — informational only (a failed
     probe is a warning, not a failure, in standalone mode); skipped with
     `--no-smoke`.
  3. **Cross-reference sensors** (`runCrossRefSensors`) — advisory warnings;
     skipped with `--no-sensors`.
- Coloured output (✔/✖/⚠/–) matching `kodr why` style.
- Returns `{ ok, command: 'check' }`; exits non-zero only on syntax failures.

**`src/app.mjs`**: added `if (options.command === 'check')` dispatch block.

**`src/cli/args.mjs`**: added `kodr check` to usage examples.

**`test/check-command.test.mjs`**: 6 tests — no files (ok), valid JS (ok),
syntax error (fail), compose without Dockerfile (warns, ok), `--no-sensors`
silences sensors, `--no-smoke` silences smoke.

## Done criteria

- [x] `kodr check` runs all three gates on the workspace and exits cleanly.
- [x] `--no-smoke` and `--no-sensors` flags respected.
- [x] 6 new tests; suite 1556 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
