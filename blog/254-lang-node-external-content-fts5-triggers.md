# Phase 254: Why the FTS5 Delete Trigger Is an INSERT

Phase 251 dogfooded an articles search app. The model built FTS5 triggers and
they looked entirely reasonable — three hooks, one per DML operation, each
touching the FTS table. But the search results broke immediately after the first
delete, with SQLite reporting:

```
missing row 3 from content table
```

Not a missing column. Not a missing table. A missing _row_ — inside the FTS5
shadow tables, in a row that had just been deleted from the base table.

## The wrong triggers

```sql
-- Wrong DELETE trigger
CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.id;
END;

-- Wrong UPDATE trigger
CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
  UPDATE articles_fts SET title = new.title, body = new.body WHERE rowid = old.id;
END;
```

These look like the obvious translations. `articles_fts` is an external-content
FTS5 table (`content='articles'`), so changes to the base table need to propagate
to the FTS index. A delete on the base table should delete from the FTS index. An
update on the base table should update the FTS index.

Both of those intuitions are wrong, and the reason is specific to how SQLite
stores external-content FTS5 tables.

## Why the base row must still exist at delete time

An external-content FTS5 table stores only the full-text index, not the document
text. When SQLite needs the content for any purpose — searching, ranking,
rebuilding — it reads from the base table. This design saves storage at the cost
of a join.

When you issue `DELETE FROM articles_fts WHERE rowid = old.id`, SQLite tries to
clean up the FTS index. That cleanup requires knowing which terms to remove from
the index. To find the terms, SQLite reads the document text — from the base
table. But the base table row was already deleted when the `AFTER DELETE` trigger
fired.

Result: SQLite searches the base table for a row that is gone. "Missing row N
from content table."

The wrong intuition is thinking that `DELETE FROM articles_fts WHERE rowid = X`
means "remove the FTS index entry for rowid X." It actually means "rebuild the
FTS index by diffing what is currently indexed against what is currently in the
base table." When the base table row is missing, the diff cannot run.

## The pseudo-row delete syntax

SQLite's FTS5 documentation describes the correct form: a special INSERT command
that tells the FTS engine to remove the indexed terms for a row using values you
supply — old field values that the trigger still has access to via `old.*`, even
after the base row is deleted:

```sql
-- Correct DELETE trigger
CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;
```

The first column in the special INSERT is the table name itself (`articles_fts`).
The value `'delete'` is a command keyword. The remaining columns are the old
field values. SQLite uses those values to walk the FTS shadow tables and remove
the right terms.

The trick: `old.title` and `old.body` are available to the trigger even though
the base row is gone. The trigger fires before the row is removed from the base
table's perspective of the trigger system, and `old.*` captures the pre-delete
values at that point.

## The UPDATE trigger

An UPDATE cannot be applied as a diff to the FTS index either — the old indexed
terms must be removed explicitly, then the new terms inserted. The correct form
is a pseudo-row delete followed by a standard rowid insert:

```sql
-- Correct UPDATE trigger
CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
```

Using `UPDATE articles_fts SET title = new.title, body = new.body WHERE rowid =
old.id` fails differently: SQLite accepts the statement but leaves the old terms
in the index. A search for the old title text will still return the row.

## Placement in the skill

The new pitfall was inserted immediately after the `**FTS5 trigger vs manual sync
— pick one**` block and before `**createDatabase factory**`. This keeps all
FTS5-specific pitfalls in sequence: query form (phase 223/253), trigger vs manual
conflict (phase 252), and now external-content trigger syntax (phase 254).

## The test

```js
it('lang:node documents correct external-content FTS5 trigger patterns', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /External-content FTS5 triggers/);
    assert.match(body, /pseudo-row delete/);
    assert.match(body, /missing row.*content table/);
    assert.match(body, /stale terms/);
    assert.match(body, /VALUES \('delete', old\.id/);
    assert.match(body, /articles_au.*AFTER UPDATE/s);
});
```

Six assertions: the section heading, the syntax term, the error message for wrong
DELETE, the symptom for wrong UPDATE, the correct DELETE syntax, and the UPDATE
trigger definition (with `/s` to match across newlines).

## Size guard update

The new block adds roughly 1626 chars to the lang:node skill body. Three size
guards in `test/system-env.test.mjs` were updated:

- Node/ESM greenfield (auto): ~19097 → 20725 chars; limit raised to 21000 // Phase 254
- Native mode: ~18004 → 19632 chars; limit raised to 20000 // Phase 254
- ESM block guard: ~19095 → 20723 chars; limit raised to 21000 // Phase 254

## Test delta

1960 → 1961 tests. 1 new assertion block in `test/builtin-skills.test.mjs`.
