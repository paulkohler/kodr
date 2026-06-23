# Phase 259: lang:sqlite FTS5 Column Projection Pitfall

## Motivation

Dogfood run 2026-06-23 (phase-257-258/sqlite-notes-api,
artifact `2026-06-23T08-09-36Z`): model wrote

```sql
SELECT id, title, body FROM notes_fts WHERE notes_fts MATCH ?
```

This throws `ERR_SQLITE_ERROR: no such column: id`. FTS5 virtual tables
expose only the columns declared in their `CREATE VIRTUAL TABLE` statement
plus `rowid`. The base table's primary key column (`id`) is not visible
under that name on the FTS table — it must be retrieved as `rowid`
(optionally aliased with `AS id`).

The pitfall is a natural follow-on from the existing FTS5 MATCH syntax
section in `lang:sqlite` and belongs immediately after it.

## Work items

- [x] Add `## FTS5 virtual-table column projection` pitfall block to
      `src/builtin-skills/languages/sqlite/SKILL.md` after the existing
      FTS5 MATCH syntax section.
- [x] Rebuild bundle: `node bin/build-skills.mjs`.
- [x] Add tests in `test/builtin-skills.test.mjs` asserting the new
      pitfall content is present in `lang:sqlite`.
- [x] Update size guards in `test/system-env.test.mjs` if needed.
- [x] `npm run format`, `npm test`, `npm run check`.
- [x] `process/decisions.jsonl` entry.
- [x] Blog post `blog/259-lang-sqlite-fts5-column-projection.md`.
- [x] Roadmap entry `- [x] 259 lang:sqlite FTS5 Column Projection Pitfall`.
- [x] Bump version to `0.0.259`.
- [ ] Commit.

## Done criteria

- [x] `lang:sqlite` skill body contains the new pitfall section.
- [x] Tests assert `/FTS5 virtual-table column projection/`,
      `/no such column: id/`, `/rowid AS id/i`, and
      `/only the columns declared/`.
- [x] Full test suite green.
- [x] `npm run check` passes.
- [x] Version is `0.0.259`.
