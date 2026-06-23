---
name: lang:node
description: Node.js / ESM coding contract — the mechanical rules local models most often break
---
# Node.js / ESM Contract
- ESM only: use `import`/`export`; never `require` or `module.exports`; no top-level `return` outside a function.
- Tests: import lifecycle hooks explicitly — `import { test, before, after } from 'node:test'`. `before`/`after` are NOT globals; omitting them from the import crashes the module with `ReferenceError: before is not defined`. Use `node:assert` only — do not invent methods like `t.assert()`.
- Shared test state: declare `let` variables at module scope, not inside `test()` blocks. Variables declared with `const`/`let` inside one `test()` block are not visible to later blocks.

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
let server, port; // module-scope so all test() blocks can share them
before(async () => { ... });
after(async () => { ... });
```
- Hook callbacks: `node:test` hooks (`before`, `after`, `beforeEach`, `afterEach`) must be **async** or return a **Promise**. The `done` callback pattern from Mocha/Jest does not exist — `done` is not injected; calling it throws `TypeError: done is not a function`.

```js
// Wrong — done is not a function in node:test; throws at runtime
before((done) => { server.listen(0, done); });
before((done) => { connect(options, done); });

// Correct A — async/await
before(async () => { await new Promise(res => server.listen(0, res)); });

// Correct B — return a Promise directly
before(() => new Promise(res => server.listen(0, res)));
```
- CLI argv: `process.argv` entries are separate tokens (`--top` and `3` are two entries); parse flags with a token loop, not a single-string regex.
- node:sqlite — `import { DatabaseSync } from 'node:sqlite'` is the only correct form. `Database`, `open`, and the default export do not exist. All methods are synchronous — never use `await` on db calls.
- ANSI truncation: truncate terminal strings by visible width, not raw `.length`. Raw length over-counts when ANSI colour codes are present, clipping mid-sequence and producing garbage output. Use the pattern below.

```js
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/gu;
function visibleWidth(str) { return str.replace(ANSI_RE, '').length; }
function truncateVisible(str, width, ellipsis = '') {
  if (visibleWidth(str) <= width) return str;
  const target = width - visibleWidth(ellipsis);
  let vis = 0, result = '', i = 0;
  while (i < str.length) {
    const m = /^\x1B\[[0-9;]*[A-Za-z]/u.exec(str.slice(i));
    if (m) { if (vis < target) result += m[0]; i += m[0].length; }
    else { if (vis >= target) break; result += str[i++]; vis++; }
  }
  return result + ellipsis;
}
```

## node:sqlite / SQLite

SQLite, FTS5, and `node:sqlite` (`DatabaseSync`) pitfalls live in the `lang:sqlite` skill — inject it alongside `lang:node` for database tasks.

## HTTP integration test patterns

Always write integration tests inline with `before`/`after` hooks — never use `child_process.fork()`, `spawn()`, or `exec()` to start the server under test. Subprocess teardown bypasses `closeAllConnections` and assertion failures inside the subprocess don't propagate as test failures.

**Server listen guard** — never call `app.listen()` at module scope in a file that exports `{ app, server }`. When tests import the module the call fires immediately and binds the port, causing `EADDRINUSE` when `before()` tries `app.listen(0)`. Guard it so the listen only runs when executed directly:

```js
// server.mjs — guard the listen call so tests can import safely
export const app = express();
export let server;

if (import.meta.url === `file://${process.argv[1]}`) {
    const port = parseInt(process.env.PORT) || 3000;
    server = app.listen(port, () => console.log(`Listening on ${port}`));
}
```

In tests, start the server explicitly in `before()`:
```js
before(async () => {
    const { app } = await import('../src/server.mjs');
    await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
});
```

**Inject the DB — `createApp(db)` factory** — do not open the database at module
scope and let routes close over it. A `const db = createDatabase()` at module
scope is unreachable from tests: setting `app.locals.db` does nothing because the
routes use the closed-over variable, so the server's DB accumulates rows while the
test resets its own — causing `UNIQUE constraint failed` and dirty-state failures.
Export a `createApp(db)` factory that takes the DB as an argument; the test
constructs the app with the DB it controls:

```js
// Wrong — module-scope db; routes close over it, tests cannot reach it
const db = createDatabase();
export const app = express();
app.post('/categories', (req, res) => { /* uses module-scope db */ });

// Correct — factory takes the db; the caller (and the test) owns it
export function createApp(db) {
  const app = express();
  app.post('/categories', (req, res) => { /* uses injected db */ });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp(createDatabase(process.env.DB_PATH ?? 'data.sqlite'));
  const port = parseInt(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Listening on ${port}`));
}
```

In tests, build the app with a fresh `:memory:` DB and reset its tables in
`beforeEach`:

```js
import { createApp } from '../src/server.mjs';
let db, app, server, port;
before(async () => {
  db = createDatabase(':memory:');
  app = createApp(db);
  await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
});
beforeEach(() => { db.exec('DELETE FROM expenses'); db.exec('DELETE FROM categories'); });
```

**Module-scope side effects** — the listen guard above is one instance of a
general rule: run no side-effectful startup at import time. Do not call
`createDatabase()`, `createServer()`, `app.listen()`, or any bootstrap at module
scope — only define and export. Importing the module for tests must do nothing
observable (no DB file opened, no port bound). Put every side effect behind the
same `import.meta.url` guard so it fires only when the file is run directly:

```js
// db.mjs / server.mjs — export factories; run nothing on import
export function createDatabase(path = ':memory:') { /* ... */ }
export const app = express();

// Only this block runs side effects, and only when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createDatabase(process.env.DB_PATH ?? 'data.sqlite');
  const port = parseInt(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Listening on ${port}`));
}
```

**Server teardown** — `server.close()` alone leaves keep-alive connections open; `node --test` hangs for 600 s. Call `closeAllConnections` first:

```js
after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
});
```

**Dynamic port capture** — `http.request({ port: 0 })` coerces to `0 || 80 = 80`, connecting to the wrong port. Capture the OS-assigned port inside the `listen` callback:

```js
let port;
await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
```

**Server startup port** — `process.env.PORT || 3000` is wrong when PORT is the string `"0"` (truthy, not coerced). Always parseInt:

```js
const port = parseInt(process.env.PORT) || 3000;
server.listen(port, () => { console.log(`Listening on ${port}`); });
```

**Check status before parsing JSON** — assert `res.ok` / `res.status` (and, when
unsure, the `content-type`) before `JSON.parse(await res.text())` or `await
res.json()`. A 404/500 returns an HTML error page, so parsing it throws
`SyntaxError: Unexpected token '<', "<!DOCTYPE "...` and masks the real failure
(the wrong status) behind a parse error:

```js
// Wrong — parses an HTML 404 page, throws SyntaxError: Unexpected token '<'
const res = await fetch(`http://localhost:${port}/items/999`);
const body = await res.json();

// Correct — on the error path, assert the status and do NOT parse a body
const missing = await fetch(`http://localhost:${port}/items/999`);
assert.equal(missing.status, 404);

// Correct — on a success, confirm 2xx + JSON before parsing
const found = await fetch(`http://localhost:${port}/items/1`);
assert.equal(found.status, 200);
assert.match(found.headers.get('content-type') ?? '', /application\/json/);
const item = await found.json();
```

## Test isolation — prefer factories over ESM cache busting

Node caches ESM modules by URL. Different query strings load distinct module
instances; the same query string reuses the cached instance. A timestamp is not
a reliable uniqueness source because multiple calls can occur in the same
millisecond, and continually importing unique URLs retains extra module
instances for the life of the process. Use a factory for deterministic test
isolation instead of `import('./mod.mjs?t=' + Date.now())`:

```js
// Fragile — Date.now() can repeat and every unique URL creates another module
async function freshInventory() {
  const mod = await import('../src/inventory.mjs?t=' + Date.now());
  return mod;
}

// Correct — export a factory; construct fresh state per test
// inventory.mjs
export function createInventory() {
  const items = new Map(); // fresh per call, never module-scope
  return { add(x) { items.set(x.id, x); }, count() { return items.size; } };
}

// inventory.test.mjs
import { describe, it, beforeEach } from 'node:test';
let inv;
beforeEach(() => { inv = createInventory(); });
```

## busboy v1

busboy v1 is a factory function, not a class. `new Busboy({...})` throws `TypeError: Busboy is not a constructor`. Call it without `new`:

```js
const busboy = Busboy({ headers: req.headers });
```
