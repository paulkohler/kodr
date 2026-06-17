# Phase 173: Secret-in-Response Sensor

## Motivation

Phase 156/157 logs showed Kodr generating JWT login routes that included the
entire user row — `password_hash`, `salt`, and all — in the signed token
payload. This is a silent security defect: the code runs, tests pass, but the
client receives the password hash. A heuristic sensor that flags when a
secret-named value reaches a serialisation or response sink catches the obvious
case without requiring a full data-flow graph.

## What this phase does

**`src/cross-ref-sensor.mjs`**:
- `SECRET_NAMES` regex: matches common sensitive field names:
  `password`, `passwd`, `pwd`, `secret`, `token`, `credential`, `api_key`,
  `auth_key`, `hash`, `salt`, `private_key`.
- `SINK_PATTERNS`: four patterns covering `res.json/send/end(`, `JSON.stringify(`,
  `jwt.sign(`/`sign(`, `return {`.
- `scanSecretLeaks(content)`: scans lines for sinks; when a sink is found,
  checks a ±4-line window for a `SECRET_NAMES` match. Returns `{ lineNo, line, pattern }[]`.
- `runSecretInResponseSensor(cwd, writePaths)`: runs `scanSecretLeaks` on all
  JS files; `ok` when no hits, `warn` with per-file line references when hits found.
- `runCrossRefSensors` now runs five sensors in parallel.

**`test/cross-ref-sensor.test.mjs`** — 8 new tests across `scanSecretLeaks` (5)
and `runSecretInResponseSensor` (3):
- Password on same line as `res.json`.
- Secret near `JSON.stringify`.
- Password hash in window near `jwt.sign`.
- No flag when sink present but no secret names.
- No flag when secret variable present but no sink.
- Sensor skips for non-JS files.
- Sensor returns ok when no leaks.
- Sensor returns warn when password reaches response.

## Trade-offs

The sensor is deliberately conservative in what it classifies as a sink — it
won't flag every serialisation, only the four patterns most commonly seen in
generated code. False positives are possible (e.g. a `token` utility that
correctly strips sensitive fields). The sensor is advisory; `--strict` will
promote it to a failure for CI gates.

## Done criteria

- [x] `scanSecretLeaks` returns hits for all four sink patterns near secrets.
- [x] `runSecretInResponseSensor` skips, ok, warn cases covered.
- [x] `runCrossRefSensors` includes the secret sensor.
- [x] 1608 tests green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
