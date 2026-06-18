# Example: Bookmark REST API

A two-session Express REST API for managing bookmarks, backed by `node:sqlite`.
No npm dependencies except Express. Session 1 builds the API. Session 2 adds tag
filtering and a search endpoint. Designed to stress:

- Express route handlers as async arrow functions (not call expressions)
- `express-async-route` sensor should be silent
- `protectExisting` forces Session 2 to patch
- `node:sqlite` direct API

## File structure after Session 1

```
package.json          — {"type":"module","dependencies":{"express":"^4"}}
src/db.mjs            — openDb(path), runMigrations(db)
src/bookmarks.mjs     — create, get, list, update, remove (all take db as first arg)
src/server.mjs        — createApp(db), startServer(port, dbPath)
test/server.test.mjs  — node:test integration: CRUD via globalThis.fetch
```

## Session 1 prompt

```
Build a bookmark REST API using Express and node:sqlite (no other deps).

package.json — {"type":"module","dependencies":{"express":"^4"}}.

src/db.mjs — import {DatabaseSync} from 'node:sqlite'.
  export function openDb(path): new DatabaseSync(path||':memory:').
  export function runMigrations(db): db.exec('CREATE TABLE IF NOT EXISTS bookmarks(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))').

src/bookmarks.mjs — all functions take db as first arg.
  export function createBookmark(db, url, title): INSERT, return {id,url,title}.
  export function getBookmark(db, id): SELECT by id, return row or null.
  export function listBookmarks(db): SELECT all ORDER BY created_at DESC, id DESC.
  export function updateBookmark(db, id, fields): UPDATE url/title, return updated row.
  export function removeBookmark(db, id): DELETE, return {changes}.

src/server.mjs — import express; import {openDb,runMigrations} from './db.mjs'; import {...} from './bookmarks.mjs'.
  export function createApp(db):
    const app = express(); app.use(express.json()).
    IMPORTANT: all route handlers must be inline async arrow functions:
      app.post('/bookmarks', async (req, res) => { ... })
      app.get('/bookmarks', async (req, res) => { ... })
      app.get('/bookmarks/:id', async (req, res) => { ... })
      app.put('/bookmarks/:id', async (req, res) => { ... })
      app.delete('/bookmarks/:id', async (req, res) => { ... })
    POST /bookmarks: createBookmark(db, url, title), respond 201.
    GET /bookmarks: listBookmarks(db), respond 200 with array.
    GET /bookmarks/:id: getBookmark, 200 or 404.
    PUT /bookmarks/:id: updateBookmark, 200 or 404.
    DELETE /bookmarks/:id: removeBookmark, 204.
    return app.
  export async function startServer(port=3000, dbPath=':memory:'):
    const db = openDb(dbPath); runMigrations(db).
    const app = createApp(db); const server = app.listen(port).
    return {app, db, server, close: ()=>new Promise(r=>{server.close(r)})}.

test/server.test.mjs — node:test, globalThis.fetch, startServer(3031).
  before: start server. after: close.
  Tests: POST /bookmarks → 201; GET /bookmarks → array; GET /:id → 200; PUT /:id → 200; DELETE /:id → 204.
```

## Session 2 prompt

```
The bookmark API is working. Add tag support.

Patch src/db.mjs: add tags table and bookmark_tags join table to runMigrations.
  CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)
  CREATE TABLE IF NOT EXISTS bookmark_tags(bookmark_id INTEGER, tag_id INTEGER, PRIMARY KEY(bookmark_id,tag_id))

Patch src/bookmarks.mjs: add
  export function addTag(db, bookmarkId, tagName): INSERT OR IGNORE into tags, then INSERT OR IGNORE into bookmark_tags. Return {bookmarkId, tagName}.
  export function getBookmarkTags(db, bookmarkId): JOIN query, return array of tag names.
  export function searchByTag(db, tagName): join query returning bookmarks that have the tag.

Patch src/server.mjs: add routes
  POST /bookmarks/:id/tags with {tag} body: addTag(db, id, tag), respond 201.
  GET /bookmarks/:id/tags: getBookmarkTags(db, id), respond 200.
  GET /bookmarks?tag=<name>: if ?tag query param present, use searchByTag instead of listBookmarks.

Patch test/server.test.mjs: add tests for tag add, tag list, and search-by-tag.
```

## What to watch for

- Does Session 1 use inline async arrow functions (not call expressions)?
- Does `express-async-route` sensor stay silent in Session 1?
- Does Session 2 correctly use patches[] (not files[])?
- Does the sensor fire if Session 2 accidentally rewrites server.mjs?
