# Phase 193: Per-Sensor Toggles via Project Config

## Motivation

The only way to suppress sensor output was `--no-sensors` — an all-or-nothing
blanket. A codebase that legitimately returns tokens in API responses would have
to disable ALL sensors to silence the `secret-in-response` noise, losing cycle
detection and the secrets-at-rest guard in the process.

## What this phase does

- Added `sensors` key to `.kodr/config.json` (validated object):
  ```json
  { "sensors": { "secret-in-response": false, "import-cycles": true } }
  ```
  Sensor names validated against `SENSOR_NAMES` values. Values must be booleans.
  An absent name is treated as enabled.

- Config `sensors` block maps to `options.sensorToggles` (not `options.sensors`,
  which remains the global boolean gate). `applyProjectConfig` applies via a
  special case in the loop, setting `options.sensorToggles = config.sensors`.

- `buildDisabledSet(sensorToggles)` helper in `cross-ref-sensor.mjs` converts
  the toggle map to a `Set<string>` of disabled names.

- `runCrossRefSensors` and `runCrossRefSensorsOnProposal` accept `opts.sensorToggles`
  and skip any sensor whose name is in the disabled set.

- `check.mjs` and `run-pipeline.mjs` pass `sensorToggles: options.sensorToggles`
  to all sensor calls.

## Known limitations

- No CLI flag for per-sensor toggle (e.g. `--no-sensor=secret-in-response`).
  Workaround: project config. CLI per-sensor flags remain a future candidate.
- No project-local sensor module hook (excluded from scope as it raises
  untrusted code execution concerns).

## Done criteria

- [x] `sensors` key in `KNOWN_KEYS` + validated in `validateValue`.
- [x] `applyProjectConfig` maps `sensors` → `options.sensorToggles`.
- [x] `buildDisabledSet` helper added.
- [x] `runCrossRefSensors` and `runCrossRefSensorsOnProposal` respect `sensorToggles`.
- [x] `check.mjs` and `run-pipeline.mjs` pass `sensorToggles` through.
- [x] 11 new tests (5 sensor-toggles in cross-ref, 6 sensors config in project-config).
- [x] Kodr integration test: `.env` not flagged when `secrets-at-rest: false`; does flag
      when config removed.
- [x] Tests pass.
- [x] Committed.
