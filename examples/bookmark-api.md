# Example: Bookmark REST API

A single-session Express REST API for managing bookmarks, backed by `node:sqlite`.
No npm dependencies except Express.

**Workspace:** `~/src/kodr-testing/phase-204/bookmark-api-4`  
**Model:** `qwen/qwen3.6-35b-a3b`

## Files

```
package.json          — {"type":"module","dependencies":{"express":"^4"}}
src/db.mjs            — openDb(path) initialises the bookmarks table
src/bookmarks.mjs     — createBookmark, getBookmark, listBookmarks, deleteBookmark
src/server.mjs        — createApp(db) → Express app
test/server.test.mjs  — node:test: 5 CRUD tests via globalThis.fetch
```

## Prompt (Session 1 — succeeded on 4th attempt)

```
Build a REST bookmark API with SQLite.

package.json — {"type":"module","dependencies":{"express":"^4"}}. Do not install busboy.

src/db.mjs — Use node:sqlite (built-in, import { DatabaseSync } from 'node:sqlite').
  export function openDb(path = ':memory:') {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    return db;
  }

src/bookmarks.mjs — CRUD functions.
  export function createBookmark(db, url, title) {
    const stmt = db.prepare('INSERT INTO bookmarks (url, title) VALUES (?, ?)');
    const result = stmt.run(url, title);
    // IMPORTANT: result.lastInsertRowid is a BigInt in node:sqlite.
    // Wrap with Number() before using as a SQL parameter.
    const id = Number(result.lastInsertRowid);
    return getBookmark(db, id);
  }
  export function getBookmark(db, id) { /* SELECT WHERE id = ? */ }
  export function listBookmarks(db) { /* SELECT ORDER BY id DESC */ }
  export function deleteBookmark(db, id) { /* DELETE WHERE id = ?, return changes count */ }

src/server.mjs — Express app.
  export function createApp(db) {
    const app = express(); app.use(express.json());
    POST /bookmarks: body {url, title} → 201 JSON bookmark object
    GET /bookmarks: → 200 JSON array
    GET /bookmarks/:id: → 200 JSON bookmark or 404 {error:'Not found'}
    DELETE /bookmarks/:id: → 204 or 404 {error:'Not found'}
    return app;
  }

test/server.test.mjs — node:test integration tests.
  import { createServer } from 'node:http';
  Use before/after hooks (NOT beforeEach/afterEach) for a single shared server instance.
  Open db with openDb(':memory:') before tests.
  Start server with app.listen(0, ...) and capture port from server.address().port.
  after(): server.closeAllConnections?.(); await new Promise(r => server.close(r));
  Use globalThis.fetch for HTTP requests (Node 24 has built-in fetch).
  Tests:
    - POST /bookmarks returns 201 with {id, url, title, created_at}
    - GET /bookmarks returns array containing the created bookmark
    - GET /bookmarks/:id returns the bookmark
    - DELETE /bookmarks/:id returns 204
    - GET /bookmarks/:id after delete returns 404

package.json — add 'scripts':{'test':'node --test'}
```

## Run

```sh
mkdir -p ~/src/kodr-testing/phase-204/bookmark-api-4
cd ~/src/kodr-testing/phase-204/bookmark-api-4
echo '{"type":"module","dependencies":{"express":"^4"}}' > package.json
npm install

kodr run --yes --no-heal --no-tools --no-inspect-context --no-protect-existing \
  --test "node --test" --max-turns 20 -p "<prompt>"
```

## Result

Run ok on first attempt with this prompt.  
Tokens: 3,355 (prompt 1,514 / completion 1,841). Tests: 5/5 passing.

## Failed attempts (see process/failures.jsonl)

Three attempts preceded this success:

| Attempt | Error |
|---------|-------|
| bookmark-api-1 | `ECONNREFUSED :80` — `port:0` JavaScript coercion bug; repair timeout |
| bookmark-api-2 | `DEFAULT (datetime('now'))` rejected by node:sqlite — only constant defaults allowed |
| bookmark-api-3 | `db.lastInsertRowid` is BigInt; cannot bind to SQL parameter; 4/5 pass |

## Notes

- `node:sqlite` returns BigInt from `stmt.run().lastInsertRowid` and `db.lastInsertRowid`.
  The explicit `Number()` cast in the prompt was essential — the model followed it exactly.
- `DEFAULT CURRENT_TIMESTAMP` is the correct node:sqlite/SQLite constant; `datetime('now')` is
  a function call and rejected as a non-constant default.
- `server.address().port` must be captured inside the `listen()` callback, not before it.
- `server.closeAllConnections?.()` is needed before `server.close()` to allow process exit.
- `--no-inspect-context` and `--no-heal` work well together for qwen3.6: full context in,
  no repair loop that can overflow the context window.
