# Phase 243: lang:node Skill — StatementSync Row-Access Pitfall

## Motivation

Phase-242-audit (`sqlite-api`): the model used `r[0]`, `r[1]`, `r[2]` to index
into `StatementSync.all()` / `get()` results. `node:sqlite` returns **named-column
objects** (`{id, title, body}`), NOT arrays — `r[0]` is always `undefined`. Two of
seven tests failed. The heal loop then burned 4094/4096 reasoning tokens in a loop
hypothesising "database reset" rather than concluding "wrong API shape".

Evidence: `process/failures.jsonl` 2026-06-21 entry, phase 242 audit artifacts.

The `lang:node` SKILL.md already has six `node:sqlite` pitfalls (import name,
BigInt bind, DEFAULT expression, :memory: in tests, FTS5 MATCH, createDatabase
factory). This adds the seventh.

## What to add

In `src/builtin-skills/languages/node/SKILL.md`, inside the
`## node:sqlite pitfalls (Node.js 24)` section, add a new block after the
**createDatabase factory** block:

```md
**StatementSync row access** — `stmt.all()` and `stmt.get()` return
**named-column objects**, not arrays. `row[0]` is always `undefined`.
Use `row.columnName`:

```js
// Wrong — StatementSync rows are objects, not arrays
const rows = db.prepare('SELECT id, title, body FROM notes').all();
const title = rows[0][1];   // undefined — no numeric index

// Correct — access by the column name
const rows = db.prepare('SELECT id, title, body FROM notes').all();
const title = rows[0].title;  // 'hello'

// Also correct for a single row
const row = db.prepare('SELECT id, title FROM notes WHERE id = ?').get(1);
const id = row.id;  // 1 (number, not BigInt unless PRAGMA applied)
```
```

## Test update

Search `test/` for any test that asserts the content of `lang:node` SKILL.md
(e.g., pitfall count, section names, or specific text). Update that test to
include the new pitfall. Run `grep -r "StatementSync\|node:sqlite\|lang:node" test/`
to find it.

If no such test exists, add one asserting the SKILL.md content includes
"row.columnName" or "named-column" in the sqlite section.

## Supporting updates

- `package.json`: bump to `0.0.243`
- `roadmap.md`: mark `- [x] 243 lang:node skill: StatementSync row-access pitfall`
- `process/decisions.jsonl`: note "phase 243 adds seventh node:sqlite pitfall to
  lang:node SKILL.md based on phase-242 dogfood evidence"
- `NEXT.md`: delete the `lang:node skill — StatementSync row-access pitfall`
  candidate block
- `blog/243-lang-node-sqlite-row-access.md`: capture the audit evidence and the fix

## Done Criteria

- [x] SKILL.md has the StatementSync row-access pitfall block with correct/wrong examples
- [x] Skill test updated (or added) to assert the new pitfall is present
- [x] `npm run format` clean, `npm run check` clean (builds skills bundle)
- [x] Blog post written
- [x] NEXT.md candidate deleted
