# Phase 193: Per-Sensor Toggles via Project Config

Until now, `--no-sensors` was the only way to suppress sensor output — and it
silenced everything. A project that legitimately returns tokens in API responses
had to choose between noisy `secret-in-response` warnings and losing cycle
detection altogether.

Phase 193 adds per-sensor control via `.kodr/config.json`.

## Usage

```json
{
  "sensors": {
    "secret-in-response": false
  }
}
```

That's it. The other sensors keep running; only `secret-in-response` is suppressed.

Valid sensor names mirror `SENSOR_NAMES`:
- `compose-dockerfile`
- `css-selector`
- `local-import`
- `import-cycles`
- `secret-in-response`
- `secrets-at-rest`

An absent sensor name means "enabled". Setting a sensor to `true` is explicit
but redundant — it's enabled by default.

## Implementation

A `buildDisabledSet(sensorToggles)` helper converts `{ 'sensor-name': false }`
to a `Set<string>`. Both `runCrossRefSensors` and `runCrossRefSensorsOnProposal`
check the set before running each sensor.

Config is loaded via `parseArgs` → `loadProjectConfig` → `applyProjectConfig`,
which maps the `sensors` block to `options.sensorToggles`. The global
`--no-sensors` flag (`options.sensors = false`) remains the blanket disable;
per-sensor toggles operate on top of it.

## Kodr integration test

`~/src/kodr-testing/phase-193/sensor-toggles/`:
- `.env` committed, `.kodr/config.json` sets `{ "sensors": { "secrets-at-rest": false } }`
- `kodr check` → no secrets-at-rest warning (sensor disabled)
- Remove config → `kodr check` → `⚠ secrets-at-rest  1 secret at rest: .env`
