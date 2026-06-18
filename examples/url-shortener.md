# Example: URL Shortener

A single-session Express URL shortener backed by `node:sqlite`. Exercises SQLite
CRUD, redirect handling, and a hit counter.

**Workspace:** `~/src/kodr-testing/phase-204/url-shortener-2`  
**Model:** `qwen/qwen3.6-35b-a3b`

## Files

```
package.json          — {"type":"module","dependencies":{"express":"^4"}}
src/db.mjs            — openDb(path) initialises the links table
src/links.mjs         — createLink, getLink, incrementHits, listLinks
src/server.mjs        — createApp(db) → Express: POST /links, GET /links, GET /:code
test/server.test.mjs  — node:test: 4 integration tests via globalThis.fetch
```

## Prompt (succeeded on 2nd attempt)

```
Build a URL shortener using Express and node:sqlite.

package.json — {"type":"module","dependencies":{"express":"^4"}}.

src/db.mjs — import { DatabaseSync } from 'node:sqlite'.
  export function openDb(path = ':memory:') {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      url TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    )`);
    return db;
  }

src/links.mjs — CRUD helpers. All imports at the top of the file (no dynamic import() inside functions).
  export function createLink(db, url, code) {
    const stmt = db.prepare('INSERT INTO links (code, url) VALUES (?, ?)');
    stmt.run(code, url);
    return getLink(db, code);
  }
  export function getLink(db, code) {
    return db.prepare('SELECT * FROM links WHERE code = ?').get(code) ?? null;
  }
  export function incrementHits(db, code) {
    db.prepare('UPDATE links SET hits = hits + 1 WHERE code = ?').run(code);
  }
  export function listLinks(db) {
    return db.prepare('SELECT * FROM links ORDER BY id DESC').all();
  }

src/server.mjs — Express app. All imports at the top of the file (no dynamic import() inside functions).
  import express from 'express';
  import { createLink, getLink, incrementHits, listLinks } from './links.mjs';
  export function createApp(db) {
    const app = express(); app.use(express.json());
    POST /links: body {url} → generate 6-char code: Math.random().toString(36).slice(2,8).
      createLink(db, url, code). Respond 201 {code, url, hits:0}.
    GET /links → 200 JSON array of all links
    GET /:code → if found, incrementHits then redirect 302 to link.url; else 404 {error:'Not found'}
    return app;
  }

test/server.test.mjs — node:test integration tests. All imports at top.
  Use before/after hooks for a single shared server instance.
  Open db with openDb(':memory:').
  Start with app.listen(0); capture port from server.address().port.
  after(): server.closeAllConnections?.(); await new Promise(r => server.close(r));
  Use globalThis.fetch with redirect:'manual' for the redirect test.
  Tests:
    - POST /links {url:'https://example.com'} returns 201 with {code, url, hits:0}
    - GET /links returns array containing the created link
    - GET /:code returns 302 Location: https://example.com
    - GET /nonexistent returns 404

package.json — add 'scripts':{'test':'node --test'}
```

## Run

```sh
mkdir -p ~/src/kodr-testing/phase-204/url-shortener-2
cd ~/src/kodr-testing/phase-204/url-shortener-2
echo '{"type":"module","dependencies":{"express":"^4"}}' > package.json
npm install

kodr run --yes --no-heal --no-tools --no-inspect-context --no-protect-existing \
  --test "node --test" --max-turns 20 -p "<prompt>"
```

## Result

Run ok on first attempt with this prompt.  
Tokens: 3,207 (prompt 1,547 / completion 1,660). Tests: 4/4 passing.

## Failed attempt (see process/failures.jsonl)

| Attempt | Error |
|---------|-------|
| url-shortener-1 | `await import('./links.mjs')` inside non-async handler (SyntaxError: Unexpected reserved word). Model had static import at top but added a redundant dynamic import for `listLinks` without making the handler async. |

## Notes

- Explicit "all imports at the top of the file, no dynamic import() inside functions"
  in the prompt prevented the model from repeating the mistake.
- `redirect:'manual'` on `globalThis.fetch` captures the 302 response without following it.
- `node:sqlite` GET by `code` (TEXT column) works without Number() cast; the BigInt issue
  only affects `lastInsertRowid` when used as a SQL bind parameter.
- The `createLink` function here avoids the BigInt issue entirely by re-querying with
  the code string rather than using lastInsertRowid.
