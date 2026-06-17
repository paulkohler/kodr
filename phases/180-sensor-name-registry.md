# Phase 180: Sensor Name Registry

## Motivation

The `kodr check --json` output includes `sensor` fields in each result, but the
names were bare string literals scattered across `cross-ref-sensor.mjs`. CI
scripts that key on sensor names have no single source of truth and risk breaking
on a typo or rename.

## What this phase does

**`src/cross-ref-sensor.mjs`**:
- Exported `SENSOR_NAMES` constant object:
  ```js
  export const SENSOR_NAMES = {
    COMPOSE_DOCKERFILE: 'compose-dockerfile',
    CSS_SELECTOR:       'css-selector',
    LOCAL_IMPORT:       'local-import',
    IMPORT_CYCLES:      'import-cycles',
    SECRET_IN_RESPONSE: 'secret-in-response',
  };
  ```
- All `sensor: 'xxx'` literals replaced with `sensor: SENSOR_NAMES.XXX`.

**`src/commands/check.mjs`**:
- Imports `SENSOR_NAMES` from cross-ref-sensor.mjs.
- `--json` output now includes `sensorRegistry: Object.values(SENSOR_NAMES)` —
  a stable array CI tools can use without importing source.

**Tests**:
- 2 new tests in `cross-ref-sensor.test.mjs`:
  - `SENSOR_NAMES` exports exactly 5 names including all expected values.
  - Sensor result `.sensor` fields match `SENSOR_NAMES` constants.
- 1 new test in `check-command.test.mjs`:
  - `--json` output includes `sensorRegistry` array of length 5 with known names.

## Done criteria

- [x] `SENSOR_NAMES` exported from `cross-ref-sensor.mjs`.
- [x] All internal `sensor:` string literals use the constants.
- [x] `kodr check --json` output includes `sensorRegistry`.
- [x] 84 tests in cross-ref-sensor.test.mjs + check-command.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
