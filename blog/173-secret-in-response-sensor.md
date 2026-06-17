# Phase 173: Secret-in-Response Sensor

A pattern that kept appearing in Kodr-generated login routes: the entire user
row gets serialised into the JWT payload or the HTTP response — including the
`password_hash`. The code is syntactically correct, the tests pass, and nothing
breaks at runtime. The secret just leaks to the client silently.

Phase 173 adds an advisory sensor that flags the obvious case.

## The heuristic

The sensor looks for two things appearing close together:

1. A **sink** — a place where data leaves the server:
   - `res.json(`, `res.send(`, `res.end(`
   - `JSON.stringify(`
   - `jwt.sign(` or bare `sign(`
   - `return {`

2. A **secret-named token** within a ±4-line window of the sink:
   `password`, `passwd`, `pwd`, `secret`, `token`, `credential`,
   `api_key`, `auth_key`, `hash`, `salt`, `private_key`

When both appear together, the sensor records a hit.

## Why a window instead of same-line matching?

Model-generated code almost always builds the object in the lines immediately
above the sink:

```js
const payload = {
  id: user.id,
  passwordHash: user.passwordHash,   // ← secret here
};
const tok = jwt.sign(payload, SECRET);  // ← sink here
```

A same-line filter would miss this entirely common pattern. A ±4-line window
catches it without being so wide that every file with a `password` variable
somewhere would trigger.

## Limitations

This is a heuristic, not a data-flow graph. False positives are possible — a
`tokenService` utility that correctly omits secrets before calling `jwt.sign`
would still trigger. The sensor is advisory: it warns, never fails. Pass
`--strict` to promote it to a failure for CI pre-commit gates.

False negatives are also possible: secrets with unusual names, multi-file
flows, and deeply nested object spreads are not caught. The goal is to flag
the egregious obvious case, not to replace a proper static analyser.
