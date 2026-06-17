# Phase 180: Canonical Sensor Name Registry

## The problem

`cross-ref-sensor.mjs` had sensor names as bare string literals repeated
across five sensor functions — a typo risk and an opaque surface for CI
scripts that need to key on sensor names.

## The fix

A single exported constant replaces all string literals:

```js
export const SENSOR_NAMES = {
  COMPOSE_DOCKERFILE: 'compose-dockerfile',
  CSS_SELECTOR:       'css-selector',
  LOCAL_IMPORT:       'local-import',
  IMPORT_CYCLES:      'import-cycles',
  SECRET_IN_RESPONSE: 'secret-in-response',
};
```

## Surfaced in `--json` output

`kodr check --json` now includes:

```json
{
  "sensorRegistry": [
    "compose-dockerfile",
    "css-selector",
    "local-import",
    "import-cycles",
    "secret-in-response"
  ],
  ...
}
```

CI scripts can validate results against this list without importing
source code. Any sensor name not in the registry signals an unexpected sensor.
