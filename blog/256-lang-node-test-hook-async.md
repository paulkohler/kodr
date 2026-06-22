# Phase 256: node:test Hooks Have No done Callback

Phase 255 dogfood: the model wrote `before((done) => { server.listen(0, done); })`.
The test suite crashed immediately with `TypeError: done is not a function`.

## Why this happens

In Mocha and Jest, lifecycle hooks accept an optional `done` callback. When the
hook function takes a parameter, the test runner injects a function as that
argument, and the hook signals completion by calling it:

```js
// Mocha / Jest — done is injected by the test runner
before((done) => { server.listen(0, done); });
```

`node:test` does not do this. There is no callback injection. When you write
`before((done) => { ... })`, the `done` parameter is `undefined` because nothing
passes a value for it. Calling it throws:

```
TypeError: done is not a function
```

The hook also returns `undefined` — not a Promise — so `node:test` treats it as
synchronously complete before the `server.listen` callback fires. The port is
never bound when the first test runs.

## Why the model writes it anyway

Mocha and Jest predate `node:test` by many years and dominate the JavaScript
testing ecosystem in training data. The `done`-callback pattern is deeply
ingrained. When the model sees a `before()` hook that wraps an async operation
(a port bind, a database connection), it reaches for the Mocha pattern because
that is what `before(callback)` means in the vast majority of Node.js test code
it was trained on.

Phase 214 documented the correct `before(async () => { ... })` form. Showing
only the right way is not enough — the model still produced the wrong form in a
phase-255 dogfood run. The wrong pattern needed to be shown explicitly and
labelled as wrong.

## The two wrong forms

```js
// Wrong — done is not a function in node:test; throws at runtime
before((done) => { server.listen(0, done); });
before((done) => { connect(options, done); });
```

The hook parameter is not injected. `done` is `undefined`. The hook also returns
`undefined`, so `node:test` considers the hook complete before the listen or
connect finishes.

## The two correct forms

```js
// Correct A — async/await
before(async () => { await new Promise(res => server.listen(0, res)); });

// Correct B — return a Promise directly
before(() => new Promise(res => server.listen(0, res)));
```

`node:test` awaits the returned Promise before proceeding to the first test.
Both forms are equivalent; the `async/await` form is more readable for hooks
that chain multiple async steps.

## Test delta

1962 → 1963 tests. One new `it` block in `test/builtin-skills.test.mjs`:
`'lang:node warns that node:test hooks must be async — no done callback'` with
5 assertions covering the error message text, both wrong forms, the `Correct A`
label, and the Promise form.

## Size guard update

The new pitfall block adds roughly 638 chars to the lang:node skill body.
Three size guards in `test/system-env.test.mjs` were updated:

- Node/ESM greenfield (auto): ~21619 → 22257 chars; limit raised to 22500 // Phase 256
- Native mode: ~20526 → 21164 chars; limit raised to 21500 // Phase 256
- ESM block guard: ~21617 → 22255 chars; limit raised to 22500 // Phase 256
