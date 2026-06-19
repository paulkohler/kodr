# Phase 218 — lang:node Skill: Server Module-Scope Listen and SQLite Memory DB

## Goal

Phase-214/215/216 dogfooding surfaced two recurring model errors not yet in the skill:

1. **Module-scope `app.listen()`** — model writes `app.listen(port)` at module scope
   in `server.mjs`, which exports `{ app, server }`. Tests import the module, the
   side-effect immediately binds the port, then `before()` fails with `EADDRINUSE`
   when it tries `server.listen(0)`.

2. **File-based SQLite in tests** — model uses a file path like `src/notes.db`
   instead of `:memory:` in test environments. State persists across test runs,
   causing "GET /notes returns empty array" to fail on second invocation.

Both patterns were correct in the skill's existing code examples but not explicitly
prohibited by a directive.

## Changes

### `src/builtin-skills/languages/node/SKILL.md`

Add two entries to the `## node:sqlite pitfalls (Node.js 24)` section:

**After the DEFAULT expression pitfall**, add:

**SQLite in tests** — use `:memory:` for the test database; a file-path database
persists state across test runs and causes "returns empty array initially" to fail:

```js
// In tests — pass :memory: so state resets each time
const db = new DatabaseSync(':memory:');
```

**After the HTTP integration test patterns intro** (before Server teardown), add:

**Server listen guard** — never call `app.listen()` at module scope in a file that
exports `{ app, server }`. When tests import the module the call fires immediately
and binds the port. Guard it so it only runs when executed directly:

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

### `src/builtin-skills.json`

Rebuild via `npm run build-skills`.

## Done criteria

- [x] SQLite `:memory:` test pattern added to pitfalls section.
- [x] Server listen guard pattern added to HTTP patterns section.
- [x] `npm run build-skills` clean.
- [x] Budget tests still pass (update limits if skill growth requires it).
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
