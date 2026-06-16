# Phase 159: Wire Cross-Reference Sensors into the Pipeline

## Motivation

Phase 158 added `src/cross-ref-sensor.mjs` with two sensors and a convenience
gate, but the sensors were not connected to anything — `runCrossRefSensors` was
only callable from tests. This phase wires them into both pipeline paths so they
run on every applied write and appear in `summary.sensors` and `kodr why`.

## What this phase does

**`src/run-pipeline.mjs`**:
- Imports `runCrossRefSensors` from `./cross-ref-sensor.mjs`.
- In the **subagent-stages path** (after the smoke-check, inside the
  `runSubagentStages` block): calls `runCrossRefSensors(subagentVerifyCwd,
  subagentWriteResult, { enabled: options.sensors !== false })` when
  `gatesEligible`. Records non-empty results as `summary.sensors`.
- In the **default path** (after the smoke-check): calls
  `runCrossRefSensors(verifyCwd, writeResult, ...)` when
  `shouldApply && !writeError && !runError`. Records non-empty results as
  `summary.sensors`.
- Both paths use `options.sensors !== false` so the planned `--no-sensors` flag
  (Phase 160) opts out without touching this code.
- Sensors are **advisory only** and never touch `runOk` or
  `deterministicGateOutcome`. A CSS selector mismatch or missing Dockerfile
  surfaces as a warning, not a failure, until the sensor's precision is proven
  on real runs.

**`src/forensics.mjs`**:
- After the smoke-check Verification step, iterates `summary.sensors`.
- `'ok'` → green `ok` step with the sensor name and message.
- `'warn'` → yellow `warn` step naming the sensor and its message.
- `'skipped'` sensors are already filtered out by `runCrossRefSensors` so they
  never reach this code.

**`test/forensics.test.mjs`**:
- Added `describe('buildCausalStory — phase 159 sensors forensics', ...)`:
  warn sensor → warn step; ok sensor → ok step; absent when no sensors.

## Done criteria

- [x] Both pipeline paths call `runCrossRefSensors` and record `summary.sensors`.
- [x] `forensics.mjs` renders sensor results in the Verification section.
- [x] 3 new forensics tests; suite 1543 green; format + check clean.
- [x] Decisions logged; blog post; roadmap checked; version bump; committed.
