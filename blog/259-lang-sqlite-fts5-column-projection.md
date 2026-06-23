# Phase 259: lang:sqlite FTS5 Column Projection Pitfall

Phase 258 wired multi-skill auto-injection so `lang:sqlite` is automatically
included in the system prompt for any Node or Rust workspace with a
SQLite-shaped task prompt. The day after it shipped, the dogfood run that
motivated Phase 258 in the first place produced a new error — a different one.

The model was building a notes REST API with FTS5 full-text search. It had
the schema right:

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='id')
```

It had the MATCH syntax right (the Phase 253 pitfall). But then it wrote:

```sql
SELECT id, title, body FROM notes_fts WHERE notes_fts MATCH ?
```

Runtime result: `ERR_SQLITE_ERROR: no such column: id`.

## Why This Fails

An FTS5 virtual table is not a view of the base table. It is its own virtual
table that exposes exactly the columns named in its `CREATE VIRTUAL TABLE`
declaration — `title` and `body` in this schema — plus `rowid`. The column `id`
does not exist on `notes_fts`. It exists on the base table `notes`, and
`content_rowid='id'` tells SQLite that `notes.id` is the rowid of the content
source — but that mapping is internal. The FTS table itself has no column named
`id`.

The correct form is:

```sql
SELECT rowid AS id, title, body FROM notes_fts WHERE notes_fts MATCH ?
```

`rowid` is always available on an FTS5 virtual table. When the content table
declares a custom `content_rowid`, `rowid` on the FTS table corresponds to that
column. Alias it and you have your primary key back.

## The Pattern

The model had four pitfalls visible in the system prompt telling it how FTS5
works: the MATCH syntax form (Phase 253), the trigger-vs-manual-sync conflict
(Phase 252), the external-content trigger pseudo-row-delete syntax (Phase 254),
and the createDatabase factory pattern (Phase 218/223). It got all of them right.
It still walked into column projection.

The failure mode is consistent with the others: the model knows FTS5 exists and
knows the MATCH syntax — it's in the training data. The projection behavior is
less frequently covered in training data because it only manifests once you try
to select a base-table column that isn't declared on the virtual table. The
runtime error doesn't name the real cause ("you asked for a column that isn't
on the virtual table"), it just says "no such column: id", which looks like a
missing declaration.

## The Fix

Add a pitfall block to `lang:sqlite` after the existing FTS5 MATCH syntax section.
Show the failing query, the error message, the schema that produced it, and the
correct `rowid AS id` form. Anchor the rule explicitly: only declared columns and
`rowid` are available on the FTS virtual table.

The implementation was a straight addition — no gating changes, no size guard
updates needed. The new section is in `lang:sqlite`, which is only injected for
SQLite tasks. The ungated Node/ESM prompt size stayed at 13,114 chars (limit:
13,500), well under the guard.

## Test Counts

Before: 1980 tests, all passing.
After: 1981 tests, all passing. 1 new test in `test/builtin-skills.test.mjs`:

- `lang:sqlite covers FTS5 virtual-table column projection pitfall` — asserts
  the four key strings: `/FTS5 virtual-table column projection/`,
  `/no such column: id/`, `/rowid AS id/i`, `/only the columns declared/`.
