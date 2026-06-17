# Phase 188: Sensor Severity Levels

## Motivation

`--strict` currently promotes all sensor warnings to failures — a blunt
instrument. `compose-dockerfile` missing a Dockerfile may be an intentional
WIP state; failing CI over it was noisy. But `local-import` finding an
unresolved module is a definite runtime crash, and `import-cycles` produces
undefined exports. These needed different weights.

## What this phase does

- Added `SENSOR_SEVERITY` export to `src/cross-ref-sensor.mjs`:
  - `compose-dockerfile`: `'warning'` — advisory, does not fail `--strict`
  - `css-selector`: `'warning'` — advisory, does not fail `--strict`
  - `local-import`: `'error'` — runtime-breaking; `--strict` promotes to failure
  - `import-cycles`: `'error'` — subtle runtime breakage; `--strict` promotes
  - `secret-in-response`: `'error'` — security concern; `--strict` promotes

- Each `warn` result from a sensor now carries a `severity` field
  (`'error'` or `'warning'`).

- Updated `check.mjs` strict-mode gate: only `severity === 'error'` warns
  fail. `warning`-severity sensors remain advisory even with `--strict`.

- Fallback in `check.mjs`: uses `SENSOR_SEVERITY[s.sensor]` when the result
  has no explicit `severity` field, defaulting to `'error'` for unknown sensors
  (safe default — unknown sensor treated as blocking).

## Done criteria

- [x] `SENSOR_SEVERITY` exported from `cross-ref-sensor.mjs`.
- [x] All `warn` sensor results include `severity` field.
- [x] `--strict` only fails on `error`-severity warns.
- [x] Tests updated: old strict test replaced with local-import (error-severity);
  new test confirms compose-dockerfile (warning-severity) stays advisory under strict.
- [x] 4 new `SENSOR_SEVERITY` registry tests.
- [x] Tests pass.
- [x] Committed.
