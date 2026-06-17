# Phase 195: Fix Sensor Issue Formatting in buildFixPrompt

## Motivation

Phase 194 shipped `kodr check --fix` but `buildFixPrompt` used wrong field names
for most sensor types. The local-import sensor returns `{ jsPath, specifier }` but
the prompt builder looked for `{ importPath }`. Four of six sensors fell back to
`JSON.stringify(issue)`, producing unreadable output like:
`local-import: {"jsPath":"src/app.mjs","specifier":"./missing.mjs"}`.

The model still managed to interpret this, but clean field names produce better
prompts and better repairs.

## What this phase does

- Extracted `formatSensorIssue(sensorName, issue)` helper with a switch statement
  covering each sensor's actual issue shape.

- Per-sensor formatting:
  - **local-import** `{ jsPath, specifier }` → `"local-import in jsPath: unresolved import 'specifier'"`
  - **compose-dockerfile** `{ buildContext, expectedDockerfile }` → `"compose-dockerfile: missing Dockerfile for build context 'ctx' (expected path)"`
  - **import-cycles** `{ cycle }` → `"import-cycles: import cycle: a → b → a"`
  - **secret-in-response** `{ jsPath, lineNo, pattern }` → `"secret-in-response in jsPath:lineNo: potential secret response (pattern: ...)"`
  - **secrets-at-rest** env-file `{ type, path }` → `"secrets-at-rest: .env file committed: path"`
  - **secrets-at-rest** hardcoded `{ type, jsPath, lineNo, name }` → `"secrets-at-rest in jsPath:lineNo: hardcoded credential 'name'"`
  - **css-selector** `{ cssPath, htmlPath, selector }` → `"css-selector in cssPath: selector 'sel' not found in htmlPath"`
  - Unknown sensors → `JSON.stringify(issue)` (safe fallback, no information lost)

## Done criteria

- [x] `formatSensorIssue` extracted with correct field mappings for all 6 sensors.
- [x] `buildFixPrompt` delegates to `formatSensorIssue` per issue.
- [x] 2 new tests: local-import uses `jsPath+specifier` format (no JSON fallback);
      secrets-at-rest env-file uses human-readable format.
- [x] `npm run format` passes.
- [x] Tests pass.
- [x] Kodr integration test: 2 missing imports fixed, 3-file clean check.
- [x] Committed.
