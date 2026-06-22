# Phase 249: lang:node Skill — DB Injection (createApp Factory) Pitfall

## The failure

The phase-248 ambitious dogfood (expense tracker, 22 tests) produced 12 failures,
all with the same root cause:

```
✖ POST /categories — duplicate name returns 409  (500 !== 409)
✖ POST /expenses — valid expense returns 201     (500 !== 201)
✖ GET /expenses — returns all expenses          (0 !== 2)
... (12 total)
```

Every failure was a `500` where a `2xx` or `4xx` was expected. The error body
from the server was always the same: `UNIQUE constraint failed: categories.name`.

The model wrote this in `server.mjs`:

```js
const db = createDatabase();   // ← module scope
export const app = express();
app.post('/categories', (req, res) => {
  const stmt = db.prepare('INSERT INTO categories ...');  // ← closes over module db
  ...
});
```

And the test file tried to inject a test-controlled db:

```js
before(async () => {
  db = createDatabase(':memory:');
  app.locals.db = db;   // ← injected into app.locals
  server = app.listen(0, ...);
});
beforeEach(() => {
  db.exec('DELETE FROM expenses');
  db.exec('DELETE FROM categories');
});
```

The `app.locals.db` injection is real — it sets a property on the Express app
object. But the routes never read `app.locals.db`. They close over the
`const db` declared at module scope. The test's `beforeEach` resets the test's
db; the server's db keeps every row ever inserted.

After the first test creates a `"Food"` category, that row lives in the module-scope
db forever. Every subsequent test that also creates `"Food"` hits the UNIQUE
constraint. Twelve of 22 tests fail from this single architectural mismatch.

## Why `app.locals.db` didn't help

The existing **SQLite test state reset** pitfall (phase 246) shows `app.locals.db = db`
as a valid injection approach for the reassignment pattern:

```js
// Alternative: reassign a fresh DB (server reads app.locals.db per request):
// db = createDatabase(':memory:');
// app.locals.db = db;
```

This works *only* when the routes actually read `req.app.locals.db` on each
request. The model absorbed the pitfall's `app.locals.db` injection line but
wrote routes that ignore it entirely — because the module-scope `db` is right
there and easier to use.

## The fix: factory that takes the db

The `createApp(db)` factory eliminates the reachability problem. Routes physically
cannot access a different db because the only db they can see is the one injected
at construction time:

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

The test constructs the app with a db it owns:

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

## Relationship to the listen guard

The `import.meta.url` listen guard (phase 218) and the `createApp(db)` factory
are companions: the listen guard fixes *where `app.listen()` runs*; this pitfall
fixes *where the db lives*.

Both are instances of the same principle: don't bind resources at module scope.
The **Module-scope side effects** pitfall (phase 227) says it as a general rule.
These two are the specific application of that rule to the two most common
resources — the port and the database.

## Evidence chain

Four lang:node pitfalls derived from direct dogfood failures:

- Phase 218: server listen guard + `:memory:` for tests (EADDRINUSE + dirty state)
- Phase 243: StatementSync row access (positional indexing returns undefined)
- Phase 246: test state reset (shared db accumulates rows across test blocks)
- Phase 249: db injection (module-scope db ignores app.locals; use createApp(db))

Each was invisible until the model wrote real code and tripped on it. No amount
of reading Express documentation would have predicted that the model would prefer
a module-scope db over `req.app.locals.db` — that required seeing the generated
code fail 12 times in the same way.
