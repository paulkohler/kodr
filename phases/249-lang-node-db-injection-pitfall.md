# Phase 249: lang:node skill — db injection (createApp factory) pitfall

## Goal

Add one pitfall to the `lang:node` builtin skill teaching the model to inject the
DB into the server via a `createApp(db)` factory instead of opening it at module
scope. This is the missing companion to the existing `import.meta.url` listen
guard: the guard fixes *where* `app.listen()` runs; this fixes *where the DB
lives* so tests can control it.

## Motivation

Phase-248 ambitious dogfood (`~/src/kodr-testing/phase-248/expense-tracker/`):
the model wrote `const db = createDatabase()` at module scope in `server.mjs`,
exported a bare `app`, and the routes closed over that module-scope `db`. The
test created its own `:memory:` DB and set `app.locals.db = db`, but the routes
ignore `app.locals` — they use the closed-over module DB. `beforeEach` reset the
test's DB while the server's DB kept accumulating rows, so 12/22 tests failed with
`UNIQUE constraint failed: categories.name`.

The fix is a single skill edit. The existing SQLite-test-reset pitfall already
shows `app.locals.db = db` injection as one valid approach; this pitfall teaches
the cleaner, less error-prone alternative — pass the DB at construction time so
the routes physically cannot reach a different DB.

## Design

Single-file edit to `src/builtin-skills/languages/node/SKILL.md` plus test
updates. No source/runtime code changes. The new text lives inside the existing
`## HTTP integration test patterns` section (gated by
`/express|node:http|http\.create|server\.listen|app\.listen/iu`); its
`app.listen` / `createApp` content keeps the section correctly gated, so plain
non-HTTP tasks still won't see it.

### 1. Where to insert

In `src/builtin-skills/languages/node/SKILL.md`, insert a new
`**Inject the DB — createApp(db) factory**` pitfall **immediately after** the
`**Server listen guard**` subsection's `before()` code block (the block ending at
the line that closes the `In tests, start the server explicitly in before():`
example, i.e. after the `});` / closing fence around line 174) and **before** the
`**Module-scope side effects**` subsection. It is the companion to the listen
guard, so it reads naturally right after it and before the broader module-scope
rule that generalizes both.

### 2. Exact text to add

````md
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
````

Keep wording terse and match the existing pitfall style (bold lead-in, one-line
"Wrong/Correct" rationale, fenced wrong-then-correct blocks).

### 3. Test additions — `test/builtin-skills.test.mjs`

Add one `it` inside the `describe('builtin skills bundle', ...)` block, alongside
the other `lang:node` assertions:

```js
it('lang:node teaches the createApp(db) factory for db injection', () => {
	const { body } = getBuiltinSkill('lang:node');
	assert.match(body, /createApp\(db\)/);
	assert.match(body, /Inject the DB/);
	assert.match(body, /routes close over it|close over the/i);
	assert.match(body, /UNIQUE constraint failed/);
});
```

### 4. Size-limit adjustments — `test/system-env.test.mjs`

The Node skill body is currently ~14.2k chars (post-246) and three guards are at
15000 / 14000 / 15000. The new pitfall (wrong+correct blocks + test snippet) adds
roughly ~900–1100 chars, which will push the auto/section bodies toward ~15.1–15.3k
and the native body toward ~14.0–14.2k — over two of the three limits. Raise all
three to **16000** and add a dated phase-249 comment line next to each:

- Line ~388 (`standard Node/ESM greenfield ... under 15000 chars (auto mode)`):
  bump `15000` → `16000` in both the `assert.ok` and the message; add comment
  `// Phase 249 added createApp(db) injection pitfall; ~15.2k chars. Limit raised to 16000.`
- Line ~451 (`native mode stays under 14000 chars`): bump `14000` → `16000` in
  both the `assert.ok` and the message (rename the `it` title too); add comment
  `// Phase 249 added createApp(db) injection pitfall; ~14.1k chars. Limit raised to 16000 (shared ceiling).`
- Line ~1046 (the second `under 15000 chars with ESM block` guard): bump `15000`
  → `16000` in both the `assert.ok` and the message; add comment
  `// Phase 249 added createApp(db) injection pitfall; ~15.2k chars. Limit raised to 16000.`

Run the suite first to read the actual post-edit char counts and set the comment
numbers to the real values (the estimates above are approximate). Do not pad the
headroom beyond ~16000 — these guards exist to catch runaway growth.

### 5. NEXT.md item to delete on ship

Delete the **`### lang:node pitfall: db injection anti-pattern`** entry (the whole
heading + paragraph) from `NEXT.md`. Also refresh the `## Current frontier` line
to mention phase 249 (db-injection createApp(db) pitfall), consistent with how
246/247/248 are listed.

## Done criteria

- [x] `**Inject the DB — createApp(db) factory**` pitfall added to SKILL.md inside
      the HTTP section, after the listen guard, before module-scope side effects.
- [x] New `lang:node teaches the createApp(db) factory` test passes in
      `test/builtin-skills.test.mjs`.
- [x] `bin/build-skills.mjs --check` passes (committed skill JSON regenerated if
      the build embeds skill bodies).
- [x] Three prompt-budget guards in `test/system-env.test.mjs` raised to 16000
      with dated phase-249 comments reflecting real char counts.
- [x] `npm run format`, full test suite, and `npm run check` clean.
- [x] `process/decisions.jsonl` notes the dogfood-sourced pitfall (provenance:
      phase-248 expense-tracker, 12/22 failures, UNIQUE constraint).
- [x] Blog post for phase 249 added/updated.
- [x] NEXT.md db-injection entry deleted; frontier line updated to 249.
- [x] Roadmap line `249 lang:node skill: db injection (createApp factory) pitfall`
      checked.
- [x] Commit captures the phase.

## Notes

- If `bin/build-skills.mjs` embeds skill bodies into a committed JSON, regenerate
  it (`node bin/build-skills.mjs`) and commit the regenerated artifact; the
  existing `build-skills --check passes against the committed JSON` test will
  otherwise fail.
- The companion NEXT.md item "SQLite skill gate: add FTS5 and :memory: as gate
  keywords" is a separate concern — leave it for its own phase.
