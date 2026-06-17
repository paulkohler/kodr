# Phase 184: Smoke-Check Heal Integration

## Motivation

The smoke-check (phase 156) runs after the heal loop. When smoke fails definitively,
the error is surfaced in `summary.ok` but no repair is attempted. The fix: convert
a smoke failure into the verification-result shape the heal loop expects, then run
a second heal pass.

## What this phase does

**`src/smoke-check.mjs`**:
- `smokeResultToVerification(smokeResult)` (exported): converts a `status: 'failed'`
  smoke result to the `{ ok, exitCode, stderr, stdout, command, durationMs, ... }`
  shape the heal loop expects. Mirrors `syntaxResultToVerification` in
  `syntax-gate.mjs`. Does not handle inconclusive outcomes — callers must check
  `smokeResult.status === 'failed'` before calling.

**`src/run-pipeline.mjs`**:
- `const smokeResult` → `let smokeResult` (needed for re-assignment after heal).
- After the initial smoke-check: if `smokeResult?.status === 'failed'` and
  `options.testCommand` is set (heal requires test verification), runs a second
  `runHealingIfNeeded` with `smokeResultToVerification(smokeResult)` as input.
- Re-runs smoke-check after the heal to get the final load-check status.
- `summary.healed` and `summary.healStopReason` updated to reflect either the
  primary heal or the smoke-driven heal.

**Known limitation**: The in-loop verification for smoke-driven heal uses
`options.testCommand`, not the smoke-check. This means the heal loop confirms each
repair via the test command, not by re-smoking. The smoke-check is only re-run once
after the full loop. If no `testCommand` is configured, no smoke-driven heal runs.
Full smoke-as-verification would require a deeper architectural change to the heal
loop.

**`test/smoke-check.test.mjs`** — 4 new tests:
- `smokeResultToVerification` returns `ok: false`, `exitCode: 1`.
- Command field includes entry point.
- `stderr` includes the error message.
- Fallback message when `message` is absent.

35 total tests pass.

## Done criteria

- [x] `smokeResultToVerification` exported and tested.
- [x] Smoke-driven heal pass wired in the main pipeline when testCommand is set.
- [x] Re-smoke after heal gets the final status.
- [x] 35 tests in smoke-check.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
