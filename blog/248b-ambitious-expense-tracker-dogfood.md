# Ambitious Test: Expense Tracker — What Broke

After phase 248 (task-gating) shipped, we ran a harder dogfood: a two-table
SQLite expense tracker with an Express REST API, FTS5 search, budget alerts, and
22 integration tests. Grade: C (10/22 pass). Here's what happened.

## The task

Build `src/db.mjs`, `src/server.mjs`, `test/api.test.mjs`:
- `categories(id, name, budget_cents)` + `expenses(id, category_id, amount_cents, description, date)` + FTS5 virtual table
- 6 REST routes: create/list categories, create/list/search expenses, budget summary
- 22 integration tests with `beforeEach` state reset

Full task in `~/src/kodr-testing/phase-248/expense-tracker/task.txt`.

## What ran

`--staged --prompt-file` timed out three times (see below). Auto-staged via `-p`
completed in 3 stages: plan → db.mjs → server.mjs + test file. 87k prompt tokens,
8k completion. Heal attempt failed with `reasoning_runaway`.

## The root failure: db injection anti-pattern

The model produced `const db = createDatabase()` at module scope in `server.mjs`.
The test creates a separate `:memory:` db and injects it with `app.locals.db = db`,
but this never reaches the server's routes — they close over the module-scope `db`.

After the first test creates a `"Food"` category, it persists in the server's db
across all `beforeEach` resets. Every subsequent test that also creates `"Food"`
hits `UNIQUE constraint failed: categories.name → 500`. Twelve tests fail from
this single root cause.

The correct pattern is a `createApp(db)` factory:

```js
// server.mjs — inject db rather than creating at module scope
export function createApp(db) {
  const app = express();
  app.post('/categories', (req, res) => {
    // db is the injected one — test controls it
  });
  return app;
}
```

Then tests do:

```js
import { createApp } from '../src/server.mjs';
let db, app, server, port;
before(async () => {
  db = createDatabase(':memory:');
  app = createApp(db);
  server = app.listen(0, ...);
});
beforeEach(() => { db.exec('DELETE FROM expenses'); db.exec('DELETE FROM categories'); });
```

The `import.meta.url` listen-guard pitfall (in the HTTP skill section) covers
the `app.listen()` placement problem. The db-injection pattern is a gap — it
needs its own pitfall entry.

## Gate finding: SQLite section missed

Phase 248 added keyword gating. The SQLite pitfalls section gates on
`/sqlite|DatabaseSync|CREATE TABLE/i`. This task's prompt wrote schema in
abbreviated form (`categories(id INTEGER PRIMARY KEY, ...)`) — never using the
words `sqlite`, `DatabaseSync`, or `CREATE TABLE`. The gate correctly did not
fire; the SQLite section was absent from the prompt.

The result: the model got no guidance on `node:sqlite` specifics (import names,
BigInt rowid, DEFAULT expressions) and chose `better-sqlite3` instead — a
perfectly valid library that the task didn't prohibit. The gate is working as
designed; the lesson is that a schema-focused task needs at least one of the
gate keywords in the prompt to pull in the pitfall section. Adding `FTS5` and
`:memory:` to the gate pattern would catch this class of task.

## `--staged --prompt-file` broken for qwen3.6-35b-a3b

Three runs timed out on the planning stage with `--staged --prompt-file`. The
staged planning API call does not set `max_tokens`. For qwen3.6-35b-a3b, LM
Studio ignores `max_thinking_tokens` and only honors `max_tokens`. Without a
`max_tokens` bound on the planning request, the model reasons indefinitely and
the 600s timeout fires.

Auto-staged (keyword detection) uses the full system prompt path and completes
reliably. `--staged` flag + `--prompt-file` is broken for thinking models where
only `max_tokens` bounds generation.

## What the model got right

The generated code shows solid understanding:
- All 6 routes implemented correctly (status codes, JSON bodies, error handling)
- FTS5 MATCH uses the virtual table name, not a column alias (correct)
- `import.meta.url` listen guard is correct
- Test file uses `node:test` + `node:assert/strict` with no invented methods
- 22 tests with proper `before`/`after`/`beforeEach` structure

The architecture flaw (module-scope db) is the only thing preventing a passing
suite. It's a teachable pattern.

## Candidates for NEXT.md

- **lang:node pitfall: db injection anti-pattern** — `createApp(db)` factory vs
  module-scope db creation. The most common cause of test isolation failures in
  server code.
- **SQLite gate: add FTS5 and :memory: keywords** — schema-focused prompts that
  don't say "sqlite" miss the pitfall section entirely.
- **Staged planning request: set max_tokens** — `--staged --prompt-file` is
  broken for models where only `max_tokens` bounds generation.
