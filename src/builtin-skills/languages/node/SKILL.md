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
- CLI argv: `process.argv` entries are separate tokens (`--top` and `3` are two entries); parse flags with a token loop, not a single-string regex.
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

## node:sqlite pitfalls (Node.js 24)

**Import name** — the only `node:sqlite` export is `DatabaseSync`. Three wrong
import forms produce runtime errors:

```js
// Wrong A — there is no `Database` export
import { Database } from 'node:sqlite';
// TypeError: Database is not a constructor

// Wrong B — there is no `open` export
import { open } from 'node:sqlite';
// TypeError: open is not a function

// Wrong C — no default export; sqlite.Database does not exist
import sqlite from 'node:sqlite';
new sqlite.Database(':memory:');
// TypeError: sqlite.Database is not a constructor

// Correct
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
```

**node:sqlite is synchronous** — every `DatabaseSync` method is blocking and
synchronous. `prepare()`, `exec()`, and the `StatementSync` methods (`all()`,
`get()`, `run()`) have no async form. `await`-ing them does nothing — it wraps
the already-resolved value in a Promise and silently returns it:

```js
// Wrong — await does nothing; node:sqlite has no async API
const rows = await db.prepare('SELECT * FROM notes').all();
await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');

// Correct — synchronous, use the return value directly
const rows = db.prepare('SELECT * FROM notes').all();
db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
```

**BigInt bind** — `stmt.run().lastInsertRowid` is a `BigInt`; passing it as a SQL parameter throws `TypeError: Provided value cannot be bound`. Cast with `Number()` before any bind:

```js
const id = Number(stmt.run(a, b).lastInsertRowid);
```

**DEFAULT expression** — `DEFAULT (datetime('now'))` is rejected as non-constant. Use the keyword constant instead:

```sql
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

**SQLite in tests** — use `:memory:` for the test database; a file-path database persists state across test runs and causes "returns empty array initially" to fail on second invocation:

```js
// In tests — pass :memory: so state resets each time
const db = new DatabaseSync(':memory:');
```

**FTS5 MATCH syntax** — the MATCH operator requires the virtual table name, not a column alias. Using an alias produces "fts5: syntax error near '.'":

```sql
-- Wrong: f is an alias, not a name MATCH accepts
SELECT f.rowid, f.title FROM articles_fts f WHERE f MATCH ?

-- Correct: use the virtual table name directly
SELECT rowid, title FROM articles_fts WHERE articles_fts MATCH ?
```

Also wrong — using the base table in `FROM` but the FTS virtual table name in
`WHERE`. SQLite error: "no such column: articles_fts":

```sql
-- Wrong: articles is the base table; articles_fts is not a column of articles
SELECT id, title FROM articles WHERE articles_fts MATCH ?

-- Correct option A: query the FTS table directly
SELECT id, title FROM articles_fts WHERE articles_fts MATCH ?

-- Correct option B: JOIN the FTS table to the base table for extra base columns
-- (bare alias f in WHERE f MATCH is valid here — f resolves to the FTS5 table, not a column)
SELECT a.id, a.title FROM articles_fts f JOIN articles a ON a.id = f.rowid WHERE f MATCH ?
```

**FTS5 trigger vs manual sync — pick one** — if you use `AFTER INSERT`,
`AFTER UPDATE`, and `AFTER DELETE` triggers to keep an FTS5 virtual table in
sync with its base table, do **not** also issue manual FTS5 content-table
commands from application code. The trigger fires automatically on every DML
statement; a manual delete in the same function removes the same row a second
time. The double-delete corrupts the FTS5 shadow tables and eventually produces
`ERR_SQLITE_ERROR: database disk image is malformed`.

```js
// Wrong — trigger fires on DELETE FROM notes, then app code deletes again
// CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
//   DELETE FROM notes_fts WHERE rowid = old.id; END;
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id); // duplicate!
}

// Correct option A — triggers only; no manual FTS commands
// CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
//   DELETE FROM notes_fts WHERE rowid = old.id; END;
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id); // trigger handles FTS
}

// Correct option B — manual sync only; no triggers
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id); // manual first
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}
```

Choose **one** approach for the entire application. Mixing triggers and manual
commands for the same table always double-applies the operation.

**External-content FTS5 triggers** — an external-content FTS5 table
(`content='articles'`) stores the FTS index but reads document text from the
base table. Its triggers must use the **pseudo-row delete syntax** — a plain
`DELETE FROM articles_fts WHERE rowid = old.id` causes "missing row N from
content table" on the next search. An `UPDATE articles_fts SET ...` leaves
stale terms in the index. Use the three correct trigger forms:

```sql
-- AFTER INSERT: standard rowid insert into FTS table
CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- AFTER DELETE: pseudo-row delete syntax (INSERT with 'delete' command)
-- Wrong: DELETE FROM articles_fts WHERE rowid = old.id
--   → causes "missing row N from content table" on next FTS search
CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;

-- AFTER UPDATE: pseudo-row delete + reinsert (UPDATE is not valid for external-content)
-- Wrong: UPDATE articles_fts SET title=new.title, body=new.body WHERE rowid=old.id
--   → stale terms from old.title/old.body remain indexed after the update
CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
```

**createDatabase factory** — never open a database with a fixed file path at module scope. When multiple test files import the same module, they share the same file-based DB, causing "database is locked" and dirty initial state. Use a factory that accepts a `path` argument defaulting to `':memory:'`:

```js
// db.mjs — accept path so tests can pass :memory:
export function createDatabase(path = ':memory:') {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, ...)`);
    return db;
}
```

In tests, always pass `':memory:'` explicitly:
```js
const db = createDatabase(':memory:');
```

**SQLite test state reset** — a shared `:memory:` DB accumulates rows across
`test()` blocks. A test that asserts "returns empty array initially" will fail
if any earlier test inserted rows. Reset table state in `beforeEach`. Both
the DB reference and any server reference must be declared at **module scope**
so `beforeEach` can capture them:

```js
import { test, before, after, beforeEach } from 'node:test';
import { app } from '../src/server.mjs'; // module-scope — visible to beforeEach
let db, server, port;

before(async () => {
    db = createDatabase(':memory:');
    app.locals.db = db; // inject into server — only works if routes read req.app.locals.db
    await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
});

after(async () => {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
});

// Correct — reset before every test so each block starts clean:
beforeEach(() => {
    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM notes_fts'); // reset FTS rows too when present
    // Alternative: reassign a fresh DB (server reads app.locals.db per request):
    // db = createDatabase(':memory:');
    // app.locals.db = db;
});
```

If `app` is only declared inside `before()`, `beforeEach` cannot see it —
`ReferenceError: app is not defined`. Always import or declare server/DB
references at module scope.

`app.locals.db` injection works **only when routes read `req.app.locals.db` on
every request**. If routes instead close over a module-scope `const db`, the
`app.locals.db` assignment is silently ignored and the server's DB accumulates
state across `beforeEach` resets. Use the `createApp(db)` factory pattern below
when routes are written with a module-scope DB variable.

**StatementSync row access** — `stmt.all()` and `stmt.get()` return
**named-column objects**, not arrays. `row[0]` is always `undefined`.
Use `row.columnName`:

```js
// Wrong — StatementSync rows are objects, not arrays
const wrongRows = db.prepare('SELECT id, title, body FROM notes').all();
const wrongTitle = wrongRows[0][1];   // undefined — no numeric index

// Correct — access by the column name
const rows = db.prepare('SELECT id, title, body FROM notes').all();
const title = rows[0].title;  // 'hello'

// Also correct for a single row
const row = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(1);
const id = row.id;  // 1 (number, not BigInt unless PRAGMA applied)
```

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
