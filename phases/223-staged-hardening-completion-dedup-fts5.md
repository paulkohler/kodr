# Phase 223 — Staged Pipeline Hardening: Completion Signal, Path Dedup, FTS5 Skill

## Goal

Three fixes from phase-222 dogfooding, all small and independent:

1. **Staged completion signal** — sentinel wording doesn't tell the model how to
   signal "all done" when it has nothing left to write. Model loops on
   `run_command(npm test)` because `write_file` is the only exit the sentinel
   offers, and it has no files to write.

2. **Path dedup in `StagedProposalTooLargeError`** — limit counts duplicate path
   mentions (10) rather than unique paths (6). A 6-unique-path repair pass falsely
   hit the 8-limit in phase-222 run 3.

3. **lang:node FTS5 MATCH syntax and createDatabase factory** — generated db.mjs
   used `WHERE f MATCH ?` (alias) instead of `WHERE articles_fts MATCH ?` (table
   name), causing "fts5: syntax error near '.'". Also `createDatabase('data.sqlite')`
   at module scope caused "database is locked" across parallel tests — fix with a
   factory that accepts a `path` parameter defaulting to `':memory:'`.

## Changes

### 1. `src/tool-calls.mjs` — staged sentinel wording

In the staged sentinel branch (where `options.inStagedPipeline === true`), append
to BOTH the standard (count < 3) and escalation (count >= 3) messages:

Standard message:
```
'This exact tool call was already made. ' +
'Call write_file for the next file you need to write. ' +
'Do not run tests or npm install. ' +
'If all files are already written, return {"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]} to complete this stage.'
```

Escalation message:
```
`You have made this identical tool call ${count} times. ` +
'Stop retrying. Call write_file for the next file you need to write. ' +
'Do not run tests or npm install — verification runs automatically after all stages complete. ' +
'If all files are already written, return {"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]} to complete this stage.'
```

### 2. `src/run-pipeline.mjs` — `runStagedPrompt` path dedup

At line ~1989, change `paths.length > maxStageWrites` to use unique path count:

```js
const paths = proposalPaths(proposal);
const uniquePaths = [...new Set(paths)];
if (uniquePaths.length > maxStageWrites) {
    writeError = {
        message: `Staged proposal touched ${uniquePaths.length} unique paths; limit is ${maxStageWrites}`,
        name: 'StagedProposalTooLargeError',
    };
    stageRecords.push({
        error: writeError,
        name: `implement-${stageIndex}`,
        paths: uniquePaths,
        responseChars: completion.text.length,
    });
    break;
}
```

Note: the `paths` variable (non-deduped) is still used for the `paths.length === 0`
check below — that check is intentional (zero writes = no progress). Only the
limit check uses unique count.

### 3. `src/builtin-skills/languages/node/SKILL.md` — FTS5 and factory pattern

Add two new entries to `## node:sqlite pitfalls (Node.js 24)` after the
`SQLite in tests` entry:

**FTS5 MATCH syntax** — the MATCH operator requires the virtual table name in the
WHERE clause, not a column alias. Using an alias produces "fts5: syntax error near '.'":

```sql
-- Wrong: f is an alias for the virtual table, not a name MATCH understands
SELECT f.rowid, f.title FROM articles_fts f WHERE f MATCH ?

-- Correct: use the virtual table name directly
SELECT rowid, title FROM articles_fts WHERE articles_fts MATCH ?
-- or use the fts5 column reference form:
SELECT rowid, title FROM articles_fts WHERE articles_fts MATCH ?
```

**createDatabase factory** — never open the database at module scope with a
fixed file path. Tests that import the module share the same file-based DB,
causing "database is locked" when multiple test files run concurrently. Use a
factory function with `:memory:` as the default:

```js
// db.mjs — accept a path argument so tests can override with :memory:
export function createDatabase(path = ':memory:') {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS items (...)`);
    return db;
}
```

In tests, always pass `:memory:`:
```js
// test/items.test.mjs
import { createDatabase } from '../src/db.mjs';
const db = createDatabase(':memory:');
```

Rebuild with `npm run build-skills` after editing SKILL.md.

### Tests

#### `test/tool-calls.test.mjs`

Update the existing Phase 220 staged sentinel tests to assert the new STAGED_DONE
wording is present in both the standard and escalation messages when
`inStagedPipeline: true`. (4 existing tests, update their assertions.)

#### `test/app.test.mjs`

Add a `Phase 223 — StagedProposalTooLargeError path dedup` suite with 2 tests:

1. A proposal with 9 write ops on 6 unique paths does NOT throw
   `StagedProposalTooLargeError` (unique count 6 <= 8).
2. A proposal with 9 writes on 9 unique paths DOES throw
   `StagedProposalTooLargeError`.

## Done criteria

- [x] Staged sentinel includes STAGED_DONE envelope example in both wording levels.
- [x] `StagedProposalTooLargeError` uses unique path count.
- [x] FTS5 MATCH pitfall added to lang:node skill.
- [x] `createDatabase` factory pattern added to lang:node skill.
- [x] `npm run build-skills` clean.
- [x] Budget tests still pass (update limits if skill grows require it).
- [x] 2 new path-dedup tests pass.
- [x] Phase 220 staged sentinel tests updated and passing.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] NEXT.md candidates removed (FIFO).
- [x] Roadmap entry marked done.
- [ ] Commit made.
