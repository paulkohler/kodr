# Phase 253: The Third Way to Get FTS5 MATCH Wrong

Phase 251 ran a dogfood against an articles search app. The model produced
full-text search code, and SQLite immediately rejected it:

```
ERR_SQLITE_ERROR: no such column: articles_fts
```

Not a missing table. Not a missing column. A column named after a table.

## What the model wrote

```sql
SELECT id, title FROM articles WHERE articles_fts MATCH ?
```

The logic is almost right. `articles_fts` is the FTS5 virtual table. `articles`
is the base table that holds the real rows. The model knew both names. It just
mixed them: the base table in `FROM`, the FTS virtual table name in `WHERE`.

SQLite sees `WHERE articles_fts MATCH ?` and tries to find a column on
`articles` called `articles_fts`. There is no such column. Hence the error.

## Why this form exists

There are three ways to write a FTS5 MATCH query, two of which are wrong:

**Form 1 — alias in WHERE** (wrong, covered since phase 223):

```sql
SELECT f.rowid, f.title FROM articles_fts f WHERE f MATCH ?
-- Error: fts5: syntax error near '.'
```

MATCH rejects a dotted alias. The virtual table name must be used bare.

**Form 2 — base table in FROM, FTS name in WHERE** (wrong, this phase):

```sql
SELECT id, title FROM articles WHERE articles_fts MATCH ?
-- Error: no such column: articles_fts
```

Mixing the two tables is a natural mistake. The model knows both names and
reaches for the FTS one in WHERE because MATCH is an FTS5 operation. But the
FTS name has to appear in the FROM clause — that is the table being queried.

**Correct form A — FTS table in both FROM and WHERE**:

```sql
SELECT id, title FROM articles_fts WHERE articles_fts MATCH ?
```

**Correct form B — JOIN when base-table columns are needed**:

```sql
SELECT a.id, a.title FROM articles_fts f JOIN articles a ON a.id = f.rowid WHERE f MATCH ?
```

## The existing pitfall block

Phase 223 added a `**FTS5 MATCH syntax**` block to SKILL.md covering Form 1 (the
alias error). That block was the right place to extend — not a new heading, not
a new pitfall, just a new Wrong/Correct pair appended to the body of the
existing block. The placement keeps all FTS5 query-form mistakes grouped.

The new text was inserted after the closing fence of the existing SQL block and
before the blank line separating it from `**FTS5 trigger vs manual sync**`.

## The test

```js
it('lang:node covers the FROM-base/WHERE-fts FTS5 MATCH failure form', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /FROM articles WHERE articles_fts MATCH/);
    assert.match(body, /no such column: articles_fts/);
    assert.match(body, /FROM articles_fts WHERE articles_fts MATCH/);
    assert.match(body, /JOIN articles.*ON.*rowid/s);
});
```

Four assertions: the wrong form, the error text, Correct A, and Correct B with
the JOIN. The `/s` flag on the last pattern lets `.*` match across newlines,
since the JOIN example spans multiple lines in the skill.

## Size guard update

The new block adds roughly 570 chars to the lang:node skill body. Three size
guards in `test/system-env.test.mjs` were updated:

- Node/ESM greenfield (auto): ~18528 → 19097 chars; limit raised to 19500
- Native mode: ~17435 → 18004 chars; limit raised to 18500
- ESM block guard: ~18526 → 19095 chars; limit raised to 19500

Each guard line carries a `// Phase 253` comment and a provenance note.

## Test delta

1959 → 1960 tests. 1 new assertion block in `test/builtin-skills.test.mjs`.
