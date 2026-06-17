# Phase 169: Smoke-Check and Sensor Hit-Rates in `kodr trends`

## Motivation

`kodr trends` already tracks ok-rate, heal rate, failure steps, and per-model
stats. The smoke-check (phase 156) and cross-reference sensors (phase 158+)
write results into every run's `summary.json`, but `computeTrends` ignored them.
Over a corpus of runs, aggregate smoke/sensor stats answer: "how often does the
smoke check catch a real load error?" and "which sensor is firing most?"

## What this phase does

**`src/trends.mjs`** — `computeTrends` additions:
- Three smoke-check counters: `smokeOkCount`, `smokeFailCount`, `smokeSkipCount`.
  Incremented from `summary.smokeCheck.status` when present.
- Two sensor fields: `sensorWarnRuns` (distinct run count with any sensor warn),
  `sensorWarns: {}` (per-sensor-name warn count).
  Accumulated from `summary.sensors[]` entries with `status: 'warn'`.

**`renderTrendsCli`** additions (only when data is present):
```
  smoke check (2 runs with entry):
    ok       1
    failed   1

  sensor warns (1 runs):
    css-selector             1
```

**`test/trends.test.mjs`** — 3 new tests:
- `computeTrends` smoke tally: ok/fail/skip each counted, runs-without-smoke ignored.
- `computeTrends` sensor warns: per-sensor count, ok-status sensors not counted.
- `renderTrendsCli` renders smoke and sensor sections when data present.

## Done criteria

- [x] `smokeOkCount/FailCount/SkipCount` correct across mixed runs.
- [x] `sensorWarnRuns` / `sensorWarns` per-sensor counts correct.
- [x] CLI renders smoke and sensor sections only when non-empty.
- [x] 23 trends tests; suite 1589 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
