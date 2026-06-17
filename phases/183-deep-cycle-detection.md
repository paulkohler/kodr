# Phase 183: `kodr check --deep` Cross-Workspace Cycle Detection

## Motivation

The import-cycle sensor (phase 172) only detects cycles within the write set.
A common miss: file A (in the write set) imports file B (existing workspace file),
and B imports A back. Without `--deep`, B is outside the graph and the cycle is
invisible. Most useful with `--changed`, where the write set is small.

## What this phase does

**`src/cross-ref-sensor.mjs`**:
- `buildDeepImportGraph(cwd, seedPaths)`: BFS from seeds, follows all local
  imports into existing workspace files. Only relative imports (not node_modules)
  are followed; `resolveLocalImportAbs` naturally limits traversal to
  workspace-local files.
- `runImportCycleSensor(cwd, writePaths, opts = {})`: accepts optional `opts.deep`.
  When true, uses `buildDeepImportGraph` instead of `buildImportGraph`, then
  filters found cycles to only those containing at least one write-set node (avoids
  flooding with pre-existing cycles in large repos). Message notes `(transitive)`
  when no cycles found in deep mode.
- `runCrossRefSensors` passes `opts.deep` to `runImportCycleSensor`.

**`src/commands/check.mjs`**:
- Passes `deep: options.deep` to `runCrossRefSensors`.

**`src/cli/args.mjs`**:
- Default `deep: false`.
- Parses `--deep` flag.
- Updated usage + `--deep` help text.

**`test/cross-ref-sensor.test.mjs`** — 2 new tests:
- `--deep` detects cycle when seed imports existing file that imports seed back.
- `--deep` returns ok when no transitive cycle touches write set.

73 tests pass.

## Done criteria

- [x] `--deep` extends cycle detection to full transitive closure from write set.
- [x] Only cycles touching the write set are reported in deep mode.
- [x] Without `--deep`, existing behaviour unchanged.
- [x] 73 tests in cross-ref-sensor.test.mjs pass.
- [x] format + check clean; decisions logged; roadmap checked; version bump; committed.
