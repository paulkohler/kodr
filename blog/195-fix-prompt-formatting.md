# Phase 195: Fix Sensor Issue Formatting in buildFixPrompt

Phase 194 shipped `kodr check --fix` — but I cut it too quickly. Four of the six
sensors fell back to `JSON.stringify(issue)` in the repair prompt because
`buildFixPrompt` used the wrong field names for their issue shapes.

The local-import sensor returns `{ jsPath, specifier }`. The prompt builder looked
for `{ importPath }`, found nothing, and emitted:

```
local-import: {"jsPath":"src/app.mjs","specifier":"./missing.mjs"}
```

The model could parse that, but it's not what you want to hand a repair agent.

## Fix

A dedicated `formatSensorIssue(sensorName, issue)` helper now switches on sensor
name and maps each sensor's actual issue fields to a clean sentence:

| Sensor | Before | After |
|--------|--------|-------|
| `local-import` | `{"jsPath":...,"specifier":...}` | `local-import in src/app.mjs: unresolved import './missing.mjs'` |
| `secret-in-response` | `{"jsPath":...,"lineNo":...,"pattern":...}` | `secret-in-response in src/app.mjs:42: potential secret response (pattern: ...)` |
| `secrets-at-rest` (env-file) | `{"type":"env-file","path":...}` | `secrets-at-rest: .env file committed: .env` |
| `secrets-at-rest` (hardcoded) | `{"type":"hardcoded","jsPath":...}` | `secrets-at-rest in src/app.mjs:7: hardcoded credential 'API_KEY'` |
| `css-selector` | `{"cssPath":...,"selector":...}` | `css-selector in styles.css: selector '#missing-id' not found in index.html` |
| `compose-dockerfile` | ✓ (already handled) | unchanged |
| `import-cycles` | ✓ (already handled) | unchanged |

Unknown sensors fall back to JSON serialisation so no information is lost.

## Kodr integration test

`~/src/kodr-testing/phase-195/fix-prompt-format/`:

- `app.mjs` imports `./engine.mjs` and `./log.mjs` (neither exists)
- `kodr check --no-smoke --fix` emits clean fix prompts
- Model creates both missing files with correct exports
- Second `kodr check --no-smoke` passes clean (3 files, 0 warnings)
