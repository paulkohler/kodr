# Phase 218: lang:node Skill — Server Listen Guard and SQLite :memory: Pattern

## The failures that prompted this phase

Dogfooding runs from phases 214–216 surfaced the same two model errors across multiple
independent attempts. Each had a correct pattern in the skill's existing code examples.
Neither had an explicit prohibition.

### EADDRINUSE on import

The model would write `server.mjs` with a module-scope `app.listen()` call:

```js
export const app = express();
export let server = app.listen(3000);
```

This compiles and runs correctly when you execute `server.mjs` directly. The problem
appears when the test file does `await import('../src/server.mjs')`. The import fires
the `listen()` call immediately, binding port 3000. Then the `before()` hook tries
`app.listen(0)` to get a random port — and hits `EADDRINUSE: address already in use`.

The existing skill had a correct "Server startup port" example that showed `parseInt`
wrapping. It didn't say anything about where `listen()` should be called. The model
had no signal that module-scope listen is wrong in a module that also exports `app`.

### Persistent SQLite state between test runs

The second failure was subtler. The model used a file-path SQLite database in tests:

```js
const db = new DatabaseSync('src/notes.db');
```

The first test run passed — `GET /notes` returned an empty array as expected, then
notes were created and retrieved correctly. The second test run failed immediately:
`GET /notes` returned a populated array instead of `[]`.

The database file persisted between runs. State from the previous run was still
there. The test that expected "initially empty" was seeing leftover entries.

The skill had nothing about test database isolation. The model's default was to use
a named file that matched the production database location.

## What was added

Both additions are titled, named pitfall entries with code patterns — the same format
as the existing BigInt bind and DEFAULT expression pitfalls.

**SQLite in tests** was added after the DEFAULT expression pitfall in the
`## node:sqlite pitfalls (Node.js 24)` section:

```js
// In tests — pass :memory: so state resets each time
const db = new DatabaseSync(':memory:');
```

The description names the exact failure mode: "persists state across test runs and
causes 'returns empty array initially' to fail on second invocation." Local models
trained on general Node.js code won't see `:memory:` as the obvious choice unless
told that file-path databases persist.

**Server listen guard** was added between the subprocess prohibition and the
Server teardown pattern in the `## HTTP integration test patterns` section:

```js
// server.mjs — guard the listen call so tests can import safely
export const app = express();
export let server;

if (import.meta.url === `file://${process.argv[1]}`) {
    const port = parseInt(process.env.PORT) || 3000;
    server = app.listen(port, () => console.log(`Listening on ${port}`));
}
```

With the corresponding `before()` pattern in tests. Placement matters: the model
reads the HTTP section sequentially. Putting the guard immediately after "never use
subprocess teardown" and before "Server teardown" means the server lifecycle pattern
is taught in one cohesive block — module guard → test startup → teardown → port capture.

## Budget impact

Two patterns added ~900 chars to the lang:node skill body. Three budget tests in
`test/system-env.test.mjs` needed updated limits:

- Auto mode (greenfield Node/ESM): 7000 → 8500 chars (measured: ~8078)
- Native mode (Node/ESM): 6100 → 7200 chars (measured: ~7003)
- ESM block test: 7000 → 8500 chars (measured: ~8076)

The limits are generous for a reason: they catch runaway growth (accidental test
regeneration, skill duplication), not wire limits. Context windows have been 32K+
since phase 146's auto-discovery, so 8500 chars is still a small fraction of available
space.

## The pattern: explicit beats implied

Both fixes follow the same principle as phases 207 and 214: encode the prohibition
explicitly rather than relying on the model to infer it from a correct example.

Phase 207 found that showing `const id = Number(stmt.run(a, b).lastInsertRowid)`
wasn't enough — the model still produced the unbounded version on fresh runs.
Adding "**BigInt bind** — `lastInsertRowid` is a `BigInt`; passing it as a SQL
parameter throws" gave the model a named pattern to recognize and avoid.

Phase 214 found that showing `before(() => { server = app.listen(0, ...) })` in
examples wasn't enough — the model still occasionally used `fork()`-based subprocess
approaches. Adding "never use `child_process.fork()`, `spawn()`, or `exec()`"
eliminated the pattern.

Phase 218 applies the same logic: a named pitfall entry with the specific error
message ("EADDRINUSE when `before()` tries `app.listen(0)`", "causes 'returns empty
array initially' to fail on second invocation") gives the model a direct recognition
target. The failure mode is named before the fix — which is also how human developers
learn from Stack Overflow.
