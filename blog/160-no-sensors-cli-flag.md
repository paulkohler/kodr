# Phase 160: `--no-sensors`

Cross-reference sensors are on by default now. Phase 160 added the escape hatch.

`--no-sensors` sets `options.sensors = false`, which is respected by both the
pipeline's `runCrossRefSensors` call and the `kodr check` gate. This follows
the same pattern as `--no-smoke` (the smoke-check opt-out) — each gate gets a
`!== false` guard rather than `=== true`, so the default is always inclusive.

Help text updated; `kodr check --no-sensors` usage added in the args help.
Nothing else changed — the sensor results in Phase 159 were already advisory
so the only thing `--no-sensors` actually suppresses is the work done computing
them, not any downstream blocking behaviour.
