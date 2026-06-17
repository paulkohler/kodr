# Phase 189: Gate-Skip Observability

## Motivation

In forensics (`summary.json`, `kodr why`), a missing `smokeCheck` field could
mean three things: disabled via `--no-smoke`, no JS entry point detected, or
write wasn't applied. These were indistinguishable — "didn't run" and "nothing
to check" looked the same as "not eligible". The phase-156/157 stress test
found this ambiguity: `summary.smokeCheck` was absent on an Express build where
the gate should have fired, with no explanation why.

## What this phase does

- Added `gateSkips` field to `check.mjs` JSON output when gates are disabled:
  - `--no-smoke`: `gateSkips.smoke = { ran: false, reason: 'disabled' }`
  - `--no-sensors`: `gateSkips.sensors = { ran: false, reason: 'disabled' }`

- Added `gateSkips` to `run-pipeline.mjs` summary in both the main path and
  subagent-stages path:
  - Write-not-applied: `syntax + smoke: { ran: false, reason: 'write-not-applied' }`
  - Write error: `syntax + smoke: { ran: false, reason: 'write-error' }`
  - Sandbox active (no host smoke): `smoke: { ran: false, reason: 'sandbox-active' }`
  - `--no-smoke`: `smoke: { ran: false, reason: 'disabled' }`
  - `--no-sensors`: `sensors: { ran: false, reason: 'disabled' }`

- `gateSkips` is absent when all gates run normally (zero-overhead for clean runs).

## Design notes

Additive field — does not change existing `syntaxCheck`, `smokeCheck`, or
`sensors` shapes. Tools that check `smokeCheck?.status === 'ok'` are unaffected.
`null` remains "ran, nothing to scan"; `gateSkips` explains explicitly disabled
or ineligible gates.

## Done criteria

- [x] `gateSkips` in `check.mjs` JSON output for disabled gates.
- [x] `gateSkips` in `run-pipeline.mjs` summary for ineligible/disabled gates.
- [x] 3 new tests in `test/check-command.test.mjs`.
- [x] Kodr test confirms `--no-smoke --json` includes `gateSkips.smoke`.
- [x] Tests pass.
- [x] Committed.
