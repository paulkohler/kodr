# Phase 203: Express Async-Route Antipattern Sensor

## Motivation

Every example run with an Express server produced the same model mistake in at
least one session:

```js
app.post('/register', register(pool))
```

`register(pool)` is an async function call — it executes immediately and returns
a Promise. Express receives the Promise as the route handler, sees a non-function,
and throws at startup:

```
Error: Route.post() requires a callback function but got a [object Promise]
```

The heap-loop saw a 500 error or a crash rather than a test failure with a useful
message. This is detectable statically: any route registration where the handler
argument is a call expression rather than a function literal or identifier reference.

## What this phase does

New sensor `express-async-route` (severity: `error`):

- `scanExpressAsyncRoutes(content)` — line-by-line scan using:
  ```
  /\b(?:app|router)\.\s*(get|post|put|patch|delete|all)\([ \t]*'...'[ \t]*,[ \t]*(?!async\b|function\b)(\w+)[ \t]*\(/
  ```
  Negative lookahead excludes `async (req, res) =>` and `function (req, res)` handlers.
  Suppressed per-line with `// kodr-ignore: express-async-route`.

- `runExpressAsyncRouteSensor(cwd, writePaths)` — runs on all JS files in the write set.

- Registered in `SENSOR_NAMES` and `SENSOR_SEVERITY`.

- Wired into `runCrossRefSensors` (post-apply) and `runCrossRefSensorsOnProposal`
  (content-safe, so runs on dry-run proposals too).

- `formatSensorIssue` case added in `check.mjs` with actionable message:
  `use async (req, res) => { await callExpr(...) } instead`.

## Done criteria

- [x] `SENSOR_NAMES.EXPRESS_ASYNC_ROUTE = 'express-async-route'`.
- [x] Severity `'error'` in `SENSOR_SEVERITY`.
- [x] `scanExpressAsyncRoutes` flags call-expression handlers, not arrow/function literals.
- [x] Negative lookahead excludes `async` and `function` keywords.
- [x] `// kodr-ignore: express-async-route` suppression.
- [x] Wired into both `runCrossRefSensors` and `runCrossRefSensorsOnProposal`.
- [x] `formatSensorIssue` case in `check.mjs`.
- [x] `project-config.mjs` validation picks up new name via `Object.values(SENSOR_NAMES)`.
- [x] 9 new tests: scan hits, scan misses, suppression, sensor runner ok/warn/skip.
- [x] Existing "six canonical names" test updated to "seven".
- [x] `npm run format` passes.
- [x] All 216 tests pass.
- [x] `npm run check` passes.
- [x] Committed.
