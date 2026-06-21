# Phase 246: lang:node Skill — SQLite Test State Reset

## The failure

The phase-245/262k dogfood ran a REST API with 14 generated tests. 11 passed.
Three failed:

```
✖ GET /notes — returns empty array initially   (1 !== 0)
✖ GET /notes — returns list after creating notes  (3 !== 2)
✖ GET /search?q=term — returns matching notes  (length > 0 is false)
```

The API code was correct — `DatabaseSync`, `Number(lastInsertRowid)`,
`CURRENT_TIMESTAMP`, `row.columnName`, FTS5 MATCH on the table name, the
`import.meta.url` listen guard all written right. The model absorbed the
lang:node pitfalls it knew about.

The test file was the problem. The model wrote a flat list of top-level `test()`
blocks, all sharing one `:memory:` DB created in `before()`. No `beforeEach` to
reset state between tests.

```
test('POST /notes — creates a note …')        // inserts id=1
test('POST /notes — returns 400 …')           // no inserts
test('POST /notes — returns 400 …')           // no inserts
test('GET /notes — returns empty array initially')  // ← expects 0, gets 1
test('GET /notes — returns list after creating 2')  // ← expects 2, gets 3
test('GET /notes/:id — returns a note by id')   // reads id=1, passes
test('DELETE /notes/:id — deletes …')           // deletes id=1
test('GET /search?q=term — returns matching')   // ← searches for id=1, gone
```

Three ordering bugs in one file. The "empty initially" test assumed a clean
slate that no longer existed. The "list of 2" test created 2 notes and expected
2, unaware there was already 1. The search test looked for a note deleted two
tests earlier.

## What the skill now says

The new **SQLite test state reset** pitfall explains the pattern and the fix:

```js
import { test, before, after, beforeEach } from 'node:test';
let db;

before(async () => {
    db = createDatabase(':memory:');
    app.locals.db = db;
    server = app.listen(0, ...);
});

// Correct — reset before every test:
beforeEach(() => {
    db.exec('DELETE FROM notes');
    db.exec('DELETE FROM notes_fts');
    // For server-injected DBs, reassign a fresh instance instead:
    // app.locals.db = createDatabase(':memory:');
});
```

It also covers the `app.locals.db` reassignment pattern for cases where the
server holds a reference to the DB — clearing the tables resets state without
needing to restart the server.

## Evidence chain

This is the third lang:node pitfall derived directly from dogfood failures:

- Phase 218: server listen guard + `:memory:` for tests (EADDRINUSE + dirty state)
- Phase 243: StatementSync row access (positional indexing returns undefined)
- Phase 246: test state reset (shared DB accumulates rows across test blocks)

Each was invisible until the model tried to write real code and tripped on it.
The skill is documentation of observed failure modes, not hypothetical guidance.
