---
name: lang:sqlite
description: node:sqlite / SQLite + FTS5 coding contract — the database pitfalls local models most often break
---
# node:sqlite / SQLite Contract

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
