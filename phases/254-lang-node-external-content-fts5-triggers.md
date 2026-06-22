# Phase 254: lang:node Skill — External-Content FTS5 Trigger Patterns

## Motivation

Phase-251 ambitious dogfood: the model wrote incorrect DELETE and UPDATE triggers
for a `content='articles'` external-content FTS5 table:

```sql
-- Wrong DELETE trigger (causes "missing row N from content table" on next search)
CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  DELETE FROM articles_fts WHERE rowid = old.id;
END;

-- Wrong UPDATE trigger (stale terms leak into the index)
CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
  UPDATE articles_fts SET title = new.title, body = new.body WHERE rowid = old.id;
END;
```

The correct patterns for external-content FTS5 tables are undocumented in most
SQLite guides. DELETE requires the pseudo-row delete syntax — an INSERT INTO fts
command with 'delete' as the first value. UPDATE requires a pseudo-row delete
followed by a reinsert. Using a plain `DELETE FROM fts` or `UPDATE fts SET ...`
causes index corruption: the former triggers "missing row N from content table"
on the next FTS search; the latter leaves stale indexed terms after the update.

## Design

Single-file edit to `src/builtin-skills/languages/node/SKILL.md` plus test and
size-limit updates. No runtime code changes.

### 1. Where to insert

Insert the new pitfall **immediately after** the `**FTS5 trigger vs manual sync
— pick one**` block and **before** the `**createDatabase factory**` block. This
keeps all FTS5-specific pitfalls grouped together.

### 2. Exact text to add

```md
**External-content FTS5 triggers** — an external-content FTS5 table
(`content='articles'`) stores the FTS index but reads document text from the
base table. Its triggers must use the **pseudo-row delete syntax** — a plain
`DELETE FROM articles_fts WHERE rowid = old.id` causes "missing row N from
content table" on the next search. An `UPDATE articles_fts SET ...` leaves
stale terms in the index. Use the three correct trigger forms:

```sql
-- AFTER INSERT: standard rowid insert into FTS table
CREATE TRIGGER articles_ai AFTER INSERT ON articles BEGIN
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;

-- AFTER DELETE: pseudo-row delete syntax (INSERT with 'delete' command)
-- Wrong: DELETE FROM articles_fts WHERE rowid = old.id
--   → causes "missing row N from content table" on next FTS search
CREATE TRIGGER articles_ad AFTER DELETE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
END;

-- AFTER UPDATE: pseudo-row delete + reinsert (UPDATE is not valid for external-content)
-- Wrong: UPDATE articles_fts SET title=new.title, body=new.body WHERE rowid=old.id
--   → stale terms from old.title/old.body remain indexed after the update
CREATE TRIGGER articles_au AFTER UPDATE ON articles BEGIN
  INSERT INTO articles_fts(articles_fts, rowid, title, body)
    VALUES ('delete', old.id, old.title, old.body);
  INSERT INTO articles_fts(rowid, title, body) VALUES (new.id, new.title, new.body);
END;
```
```

### 3. Test additions — `test/builtin-skills.test.mjs`

Add one `it` block immediately after the FROM-base/WHERE-fts test:

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

### 4. Size-limit adjustments — `test/system-env.test.mjs`

After editing SKILL.md, run `npm test` — the three size guards will fail with
exact measured values. Set each ceiling to the next clean 500 above the measured
value. Add a dated `// Phase 254` comment on each guard line.

### 5. NEXT.md and roadmap

- Delete the `### lang:node external-content FTS5 trigger patterns` block from `NEXT.md`
- Update `## Current frontier` to mention phase 254
- Mark `- [x] 254 lang:node External-Content FTS5 Trigger Patterns` in `roadmap.md`

## Done criteria

- [x] `**External-content FTS5 triggers**` pitfall added after FTS5-trigger-vs-manual-sync block.
- [x] Contains: "pseudo-row delete", "missing row N from content table", "stale terms",
      wrong DELETE form, correct DELETE pseudo-row form, wrong UPDATE form, correct
      UPDATE delete+reinsert form, all three trigger hooks (INSERT/DELETE/UPDATE).
- [x] `it('lang:node documents correct external-content FTS5 trigger patterns', ...)`
      passes with six assertions.
- [x] Three prompt-budget guards raised with phase-254 dated comments.
- [x] `npm run format`, full test suite, and `npm run check` clean.
- [x] `process/decisions.jsonl` records provenance.
- [x] Blog post `blog/254-lang-node-external-content-fts5-triggers.md` added.
- [x] NEXT.md entry deleted; frontier updated to 254.
- [x] Roadmap line checked.
- [ ] Commit captures the phase.
