# Phase 172: Import Cycle Detection Sensor

## Motivation

The local-import existence sensor (phase 167) checks that import targets exist on
disk. The next natural check is whether any of those imports form a cycle. Circular
imports don't crash Node.js, but they can produce `undefined` exports at runtime
because the module graph has not finished loading when the cycle is traversed — a
class of defect that is silent and hard to debug.

## What this phase does

**`src/cross-ref-sensor.mjs`**:
- Added `relative` to the `node:path` import.
- Refactored `resolveLocalImport` into `resolveLocalImportAbs` (returns the
  absolute path, or null) + `resolveLocalImport` (boolean wrapper). Both
  `runLocalImportSensor` and the new cycle sensor use the shared helper.
- `buildImportGraph(cwd, jsPaths)` — reads each JS file in the write set,
  extracts relative imports, resolves them to workspace-relative paths, and
  records edges between files that are both in the write set. Returns
  `{ graph: Map<path, path[]>, readCount }`.
- `findCycles(graph)` (exported) — iterative DFS with a visiting/visited set;
  deduplicates cycles by canonicalizing (rotate so the lexicographically smallest
  node is first). Returns an array of cycle arrays, each ending with the start
  node.
- `runImportCycleSensor(cwd, writePaths)` — skips when no JS files or no
  readable JS files; returns `ok` when no cycles, `warn` with cycle details when
  at least one cycle is found.
- `runCrossRefSensors` now runs four sensors in parallel and adds
  `runImportCycleSensor` to the result set.

**`test/cross-ref-sensor.test.mjs`** — 8 new tests across `findCycles` (4) and
`runImportCycleSensor` (4):
- Two-node cycle detection.
- Three-node cycle detection (cycle length = 4 including repeated node).
- No cycles → empty array.
- Deduplication: A→B→A found from two entry points → one result.
- Sensor skips when no JS files in write set.
- Sensor skips when JS files don't exist on disk.
- Sensor returns ok for a DAG (a→b, b has no imports back to a).
- Sensor returns warn when a→b→a cycle is present.

## Done criteria

- [x] `findCycles` detects 2-node and 3-node cycles and deduplicates.
- [x] `runImportCycleSensor` skips, ok, warn cases covered.
- [x] `runCrossRefSensors` includes the cycle sensor result.
- [x] 1600 tests green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
