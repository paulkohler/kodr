# Phase 252: lang:node Skill — FTS5 Trigger vs Manual Delete Conflict

## Motivation

Phase-245 dogfood: the model set up an `AFTER DELETE` trigger on the `notes`
table that automatically removed the corresponding row from the FTS5 shadow
table, AND also issued a manual delete in the `deleteNote()` application
function:

```js
// Trigger fires on DELETE FROM notes (schema)
// CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
//   DELETE FROM notes_fts WHERE rowid = old.id;
// END;

// Also in deleteNote() (application code) — wrong: double-delete
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id); // duplicate!
}
```

The trigger fires on `DELETE FROM notes`. The application code then issues a
second `DELETE FROM notes_fts` for the same rowid. SQLite's FTS5 internal
accounting (the shadow tables `_data`, `_idx`, etc.) gets corrupted, eventually
producing:

```
ERR_SQLITE_ERROR: database disk image is malformed
```

This is not a disk failure. It is an FTS5 index integrity violation caused by
the double-delete. The fix: pick one sync strategy and use only that.

## Design

Single-file edit to `src/builtin-skills/languages/node/SKILL.md` plus test
and size-limit updates. No runtime code changes.

### 1. Where to insert

In `src/builtin-skills/languages/node/SKILL.md`, insert the new pitfall
**immediately after** the existing `**FTS5 MATCH syntax**` block and
**before** the `**createDatabase factory**` block. This keeps all FTS5-specific
pitfalls together at the top of the SQLite pitfalls section.

### 2. Exact text to add

```md
**FTS5 trigger vs manual sync — pick one** — if you use `AFTER INSERT`,
`AFTER UPDATE`, and `AFTER DELETE` triggers to keep an FTS5 virtual table in
sync with its base table, do **not** also issue manual FTS5 content-table
commands from application code. The trigger fires automatically on every DML
statement; a manual delete in the same function removes the same row a second
time. The double-delete corrupts the FTS5 shadow tables and eventually produces
`ERR_SQLITE_ERROR: database disk image is malformed`.

​```js
// Wrong — trigger fires on DELETE FROM notes, then app code deletes again
// CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
//   DELETE FROM notes_fts WHERE rowid = old.id; END;
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id); // duplicate!
}

// Correct option A — triggers only; no manual FTS commands
// CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
//   DELETE FROM notes_fts WHERE rowid = old.id; END;
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id); // trigger handles FTS
}

// Correct option B — manual sync only; no triggers
function deleteNote(db, id) {
  db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(id); // manual first
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}
​```

Choose **one** approach for the entire application. Mixing triggers and manual
commands for the same table always double-applies the operation.
```

### 3. Test additions — `test/builtin-skills.test.mjs`

Add one `it` block inside the `describe('builtin skills bundle', ...)` block
after the existing `lang:node teaches the createApp(db) factory` test:

```js
it('lang:node warns that mixing FTS5 triggers and manual deletes corrupts the index', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /FTS5 trigger vs manual sync/);
    assert.match(body, /database disk image is malformed/);
    assert.match(body, /double-delete|duplicate/i);
    assert.match(body, /pick one/i);
});
```

### 4. Size-limit adjustments — `test/system-env.test.mjs`

The new pitfall block adds approximately 900–1100 chars. After editing the skill
file, run `npm test` — the three size guards will fail with actual char counts.
Set each ceiling to the next clean thousand above the measured size. Keep
headroom ≤ 1000 chars. Add a dated phase-252 comment on each guard line.

### 5. NEXT.md and roadmap

- Delete the `### lang:node FTS5 trigger vs manual delete conflict` block from `NEXT.md`
- Update `## Current frontier` paragraph to mention phase 252
- Mark `- [x] 252 lang:node FTS5 Trigger vs Manual Delete Conflict` in `roadmap.md`

## Done criteria

- [x] `**FTS5 trigger vs manual sync — pick one**` pitfall added to SKILL.md
      immediately after the `**FTS5 MATCH syntax**` block, before
      `**createDatabase factory**`.
- [x] New pitfall contains: "pick one" rule, Wrong example (trigger + manual
      delete in same function), Correct option A (triggers only), Correct
      option B (manual only), and the error text `database disk image is malformed`.
- [x] `it('lang:node warns that mixing FTS5 triggers and manual deletes corrupts
      the index', ...)` test passes in `test/builtin-skills.test.mjs`.
- [x] Three prompt-budget guards in `test/system-env.test.mjs` raised with
      phase-252 dated comments reflecting real char counts.
- [x] `npm run format`, full test suite, and `npm run check` clean.
- [x] `process/decisions.jsonl` records provenance (phase-245 dogfood,
      double-delete, `database disk image is malformed`).
- [x] Blog post `blog/252-lang-node-fts5-trigger-conflict.md` added.
- [x] NEXT.md FTS5-trigger entry deleted; frontier line updated to 252.
- [x] Roadmap line checked.
- [x] Commit captures the phase.
