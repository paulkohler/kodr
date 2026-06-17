# Phase 182: `kodr check` TTY Summary Line

## Motivation

After `kodr check` finishes, the user had to read each sensor line to get a feel
for what ran. A one-line summary printed before the final pass/fail gives a quick
pulse check at a glance.

## What this phase does

**`src/commands/check.mjs`** — `renderAnsi`:
- After sensor output, computes:
  - `sensorsRun` — sensors that ran (not skipped).
  - `warnCount` — sensors that warned.
- Prints a dimmed summary line: `N files · N sensors · N warnings`.
  `· N sensors` is omitted when 0. `· N warnings` is omitted when 0.
- Summary line only appears in TTY mode (not `--json`).
- Empty workspace skips the summary (takes the existing early-return path).

**`test/check-command.test.mjs`** — 2 new tests:
- TTY output for valid workspace matches `\d+ files?` pattern.
- TTY output when compose sensor warns matches `1 warning`.

15 total tests pass.

## Done criteria

- [x] Summary line printed in TTY mode: `N files · N sensors · N warnings`.
- [x] Omits sensor/warning segments when counts are zero.
- [x] Not emitted in `--json` mode.
- [x] 15 tests in check-command.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
