# Phase 160: `--no-sensors` CLI Flag

## Motivation

Phase 159 wired `runCrossRefSensors` into both pipeline paths using
`options.sensors !== false` as the gate. This phase adds the flag that lets
callers set that option to `false`.

## What this phase does

- `src/cli/args.mjs`: adds `sensors: true` to defaults; adds `--no-sensors`
  parse branch (mirrors `--no-smoke` pattern exactly); adds help text.
- `test/app.test.mjs`: adds `'parses --no-sensors (phase 160); sensors on by
  default'` test verifying `sensors` defaults to `true` and `--no-sensors`
  sets it `false`.

## Done criteria

- [x] `--no-sensors` parses and sets `options.sensors = false`.
- [x] Sensors on by default (`sensors: true` in defaults).
- [x] 1 new test; suite 1544 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
