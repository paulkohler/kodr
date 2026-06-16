# Phase 167: Local Import-Path Existence Sensor

## Motivation

The most common class of model-write failure: the model writes a file that
imports from a peer it forgot to create. The smoke-check catches this at
runtime (`ERR_MODULE_NOT_FOUND`), but only when an entry point is detectable
and JS was written. A deterministic, model-free sensor can catch it earlier —
at write time, for any JS file, regardless of whether there's a detectable
entry — and without running any code.

This is exactly the failure measured by the `js-extract-module` eval fixture:
a test file imports `src/utils.mjs` which doesn't exist yet.

## What this phase does

**`src/cross-ref-sensor.mjs`** — three new exports:

- `extractLocalImportPaths(content)`: extracts relative `import`/`export from`
  specifiers from JS source text using two regex patterns (deduped with a Set).
  Only returns specifiers starting with `.` or `..`; ignores bare specifiers
  and Node built-ins.

- `resolveLocalImport(specifier, importerAbsDir)`: resolves a specifier against
  the importer's directory. Tries the path as-is first; when no extension, also
  tries `+.mjs`, `+.js`, `+.cjs`, and `/index.mjs|.js|.cjs`. Returns `true`
  when any candidate exists on disk.

- `runLocalImportSensor(cwd, writePaths)`: scans `.mjs`, `.js`, `.cjs` files
  in the write set, extracts relative imports, resolves each. Returns a sensor
  result `{ sensor: 'local-import', status, checked, issues, message }` with
  `status: 'warn'` when any import is unresolved.

**`runCrossRefSensors`** updated to run all three sensors in parallel
(`compose`, `css`, `localImport`) and filter out skipped results as before.

**`test/cross-ref-sensor.test.mjs`** — 13 new tests:
- `extractLocalImportPaths`: 5 tests (named/default imports, side-effect
  import, export-from, ignores bare specifiers, deduplication).
- `resolveLocalImport`: 4 tests (exact path, extensionless → .mjs, missing,
  directory → index.mjs).
- `runLocalImportSensor`: 4 tests (skip on no JS, ok all resolve, warn on
  missing, extensionless ok).

## Done criteria

- [x] `extractLocalImportPaths` deduplicates; ignores non-relative specifiers.
- [x] `resolveLocalImport` tries extension candidates in order.
- [x] `runLocalImportSensor` skips when no readable JS files; warns on unresolved.
- [x] `runCrossRefSensors` includes `local-import` alongside compose and css.
- [x] Pre-existing 32 cross-ref-sensor tests still pass (45 total).
- [x] Suite 1583 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
