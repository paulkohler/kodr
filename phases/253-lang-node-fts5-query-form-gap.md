# Phase 253: lang:node Skill — FTS5 Query Form Gap (FROM base table, WHERE fts name)

## Motivation

Phase-251 ambitious dogfood: the model wrote:

    SELECT id, title FROM articles WHERE articles_fts MATCH ?

using the base table (`articles`) in the `FROM` clause but referencing the FTS
virtual table name (`articles_fts`) in the `WHERE` clause. SQLite raises:

    ERR_SQLITE_ERROR: no such column: articles_fts

The existing `**FTS5 MATCH syntax**` pitfall block (added in phase 223) covers
only the alias failure form:

    SELECT f.rowid, f.title FROM articles_fts f WHERE f MATCH ?

where `f` is an alias and MATCH rejects it with "fts5: syntax error near '.'".

That covers two failure forms. The third — `FROM base_table WHERE fts_name MATCH ?`
— is equally plausible (and was actually produced), but is not covered.
This phase extends the existing pitfall block with a Wrong/Correct pair for this
third form.

## Design

Single-file edit to `src/builtin-skills/languages/node/SKILL.md` plus test and
size-limit updates. No runtime code changes.

### 1. Where to insert

The new Wrong/Correct examples go **inside** the existing `**FTS5 MATCH syntax**`
block, appended after the current code fence, before the blank line separating it
from `**FTS5 trigger vs manual sync — pick one**`.

This is an extension of the existing pitfall, not a new pitfall heading.

### 2. Exact text to add

Append the following to the body of the `**FTS5 MATCH syntax**` pitfall (after the
closing fence of the current SQL block):

```md
Also wrong — using the base table in `FROM` but the FTS virtual table name in
`WHERE`. SQLite error: "no such column: articles_fts":

```sql
-- Wrong: articles is the base table; articles_fts is not a column of articles
SELECT id, title FROM articles WHERE articles_fts MATCH ?

-- Correct option A: query the FTS table directly
SELECT id, title FROM articles_fts WHERE articles_fts MATCH ?

-- Correct option B: JOIN the FTS table to the base table for extra base columns
SELECT a.id, a.title FROM articles_fts f JOIN articles a ON a.id = f.rowid WHERE f MATCH ?
```
```

### 3. Test additions — `test/builtin-skills.test.mjs`

Add one `it` block immediately after the phase-252 FTS5 trigger test:

```js
it('lang:node covers the FROM-base/WHERE-fts FTS5 MATCH failure form', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /FROM articles WHERE articles_fts MATCH/);
    assert.match(body, /no such column: articles_fts/);
    assert.match(body, /FROM articles_fts WHERE articles_fts MATCH/);
    assert.match(body, /JOIN articles.*ON.*rowid/s);
});
```

Four assertions covering: the wrong form, the error text, Correct A, and Correct B.

### 4. Size-limit adjustments — `test/system-env.test.mjs`

After editing SKILL.md, run `npm test` — the three size guards will fail with exact
measured values. Set each ceiling to the next clean 500 above the measured value.
Add a dated `// Phase 253` comment on each guard line.

### 5. NEXT.md and roadmap

- Delete the `### lang:node FTS5 query form gap (FROM base_table WHERE fts_table MATCH)` block from `NEXT.md`
- Update `## Current frontier` to mention phase 253
- Mark `- [x] 253 lang:node FTS5 Query Form Gap` in `roadmap.md`

## Done criteria

- [x] `**FTS5 MATCH syntax**` block in SKILL.md extended with:
      - Wrong: `SELECT id, title FROM articles WHERE articles_fts MATCH ?`
      - Correct A: `SELECT id, title FROM articles_fts WHERE articles_fts MATCH ?`
      - Correct B: JOIN form
      - Error string: `"no such column: articles_fts"`
- [x] `it('lang:node covers the FROM-base/WHERE-fts FTS5 MATCH failure form', ...)`
      test passes with four assertions.
- [x] Three prompt-budget guards in `test/system-env.test.mjs` raised with
      phase-253 dated comments reflecting real char counts.
- [x] `npm run format`, full test suite, and `npm run check` clean.
- [x] `process/decisions.jsonl` records provenance (phase-251 dogfood, FROM-base/WHERE-fts, no such column).
- [x] Blog post `blog/253-lang-node-fts5-query-form-gap.md` added.
- [x] NEXT.md `lang:node FTS5 query form gap` entry deleted; frontier updated to 253.
- [x] Roadmap line checked.
- [x] Commit captures the phase.
