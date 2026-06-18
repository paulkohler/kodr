# Phase 203: Express Async-Route Antipattern Sensor

The auth-app example (Session 2) introduced a runtime crash that Express surfaced
only after all route handlers were registered. The model wrote:

```js
app.post('/register', register(pool))
```

`register(pool)` is an async function — calling it returns a Promise immediately.
Express receives the Promise where it expects a callback function and throws at
startup:

```
Error: Route.post() requires a callback function but got a [object Promise]
```

Tests that `fetch('/register')` get a connection refused or a 500, not a test
assertion failure with a line number. The heal loop has to diagnose backward from
the test failure to the wrong line in `server.mjs`.

The correct form:

```js
app.post('/register', async (req, res) => {
  const user = await register(pool, req.body.username, req.body.password);
  res.status(201).json(user);
})
```

## The sensor

`express-async-route` scans JS files for route registrations where a handler
argument is a direct call expression rather than a function literal or reference.

The regex:
```
/\b(?:app|router)\.\s*(get|post|put|patch|delete|all)\([ \t]*'...'[ \t]*,[ \t]*
  (?!async\b|function\b)(\w+)[ \t]*\(/
```

The negative lookahead `(?!async\b|function\b)` is the key: it passes
`async (req, res) =>` and `function(req, res)` handlers unchanged while flagging
`register(pool)`.

Per-line suppression: `// kodr-ignore: express-async-route`.

Severity is `error` — this is always a runtime crash, not advisory.

## Where it runs

The sensor is content-safe (reads only the file being written, no external
references), so it runs in both:

- `runCrossRefSensors` — post-apply, after writes hit disk
- `runCrossRefSensorsOnProposal` — pre-apply, in the proposal path

The proposal path is the valuable one: it flags the issue before the writes are
applied, giving the heal loop an error to act on before tests even run.

The `buildFixPrompt` case produces:

```
express-async-route in src/server.mjs:42: route handler 'register(...)' is a
call expression — use async (req, res) => { await register(...) } instead
```

## Lesson

This antipattern came from a model that had `register(pool)` returning a value
in Session 1 and then in Session 2 tried to reuse that pattern directly as a
route handler. The mistake is compositionally sensible (functions that accept pools
and return things) but wrong in the Express handler position. Static detection
before tests run is cheaper than diagnosing from a 500.
