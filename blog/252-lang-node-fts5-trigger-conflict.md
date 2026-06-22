# Phase 252: The Double-Delete That Silently Corrupts FTS5

Phase 245 built a notes API with full-text search. The model set up the FTS5
index correctly — virtual table, triggers, the works. Every test passed. Then,
on a second dogfood run, deleting a note produced this:

```
ERR_SQLITE_ERROR: database disk image is malformed
```

Not a disk failure. A logic failure hiding in plain sight.

## What happened

The model wrote an `AFTER DELETE` trigger in the schema to keep the FTS5 index
in sync with the base table:

```sql
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE rowid = old.id;
END;
```

And then, in the application code, `deleteNote()` also deleted from the FTS
table:

```js
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id); // "just to be safe"
}
```

The trigger fires automatically when the `DELETE FROM notes` runs. Before the
application code even reaches the second statement, the FTS row is already gone.
The second delete then targets a row that no longer exists — but it does not
simply no-op. SQLite's FTS5 internal accounting (the shadow tables `_data`,
`_idx`, `_docsize`, `_content`, `_config`) tracks positions and sizes
independently of the main row. Deleting a non-existent row confuses that
accounting. Over repeated inserts and deletes, the shadow tables drift out of
sync with what was actually stored. The `malformed` error is the deferred
symptom.

What made it hard to catch: the error did not appear immediately. On a fresh
database the double-delete looked harmless. The corruption accumulated silently
across multiple operations. By the time the error surfaced, the original cause
was buried several test runs back.

## The rule

**Pick one sync strategy and use only that.** Either:

- **Triggers only** — write the FTS DML in schema triggers; application code
  touches only the base table.
- **Manual sync only** — no triggers; application code issues both the base-table
  DML and the matching FTS DML, in the correct order.

Mixing the two approaches for the same table always double-applies the
operation, regardless of whether the double-delete is detectable immediately.

## The fix

A single block added to the lang:node SKILL.md FTS5 pitfalls section, between
the existing `**FTS5 MATCH syntax**` block and the `**createDatabase factory**`
block. The placement keeps all FTS5-specific pitfalls together:

```md
**FTS5 trigger vs manual sync — pick one** — if you use AFTER INSERT, AFTER
UPDATE, and AFTER DELETE triggers to keep an FTS5 virtual table in sync with
its base table, do not also issue manual FTS5 content-table commands from
application code. The trigger fires automatically on every DML statement; a
manual delete in the same function removes the same row a second time. The
double-delete corrupts the FTS5 shadow tables and eventually produces
ERR_SQLITE_ERROR: database disk image is malformed.
```

The code examples in the block show the wrong pattern (trigger + manual
duplicate), correct option A (triggers only), and correct option B (manual
only).

## The test

```js
it('lang:node warns that mixing FTS5 triggers and manual deletes corrupts the index', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /FTS5 trigger vs manual sync/);
    assert.match(body, /database disk image is malformed/);
    assert.match(body, /double-delete|duplicate/i);
    assert.match(body, /pick one/i);
});
```

Four assertions, each covering a distinct part of the pitfall: the title (rule),
the error message (consequence), the mechanism (double-delete/duplicate), and the
fix instruction (pick one).

## Size guard update

The new block adds approximately 1000 chars to the lang:node skill body. Three
size guards in `test/system-env.test.mjs` were updated:

- Node/ESM greenfield (auto): 17009 → 18528 chars; limit raised to 19000
- Native mode: 15687 → 17435 chars; limit raised to 18000
- ESM block guard: 17009 → 18526 chars; limit raised to 19000

Each guard line carries a `// Phase 252` comment and a provenance note.

## Test delta

1958 → 1959 tests. 1 new assertion block in `test/builtin-skills.test.mjs`.
