# Phase 223: Staged Pipeline Hardening — Completion Signal, Path Dedup, FTS5 Skill

Three independent fixes extracted from phase-222 dogfooding. Each one closed a
loop that was keeping tasks from completing.

## Fix 1: STAGED_DONE completion signal in the sentinel

Phase-222 dogfooding produced a consistent third-stage failure: after all target
files were written, the model entered stage 2 (or a later stage) and had nothing
left to write. The staged sentinel is designed to block test runs and redirect the
model to `write_file`, but when there are no files left to write, the model had
nowhere to go. It looped on `run_command(npm test)`, the sentinel fired, the model
retried, the sentinel fired again, and eventually a `ProposalMissingError` broke
the loop.

The sentinel message said: "Call `write_file` for the next file you need to write."
That instruction is correct when writing remains. When writing is complete it is a
dead end.

The fix adds a second branch to both message levels — standard (count < 3) and
escalation (count >= 3):

```
If all files are already written, return {"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]} to complete this stage.
```

This gives the model a concrete exit action that the pipeline already knows how
to handle. The `paths.length === 0` branch in `runStagedPrompt` already checks
for `STAGED_DONE` in `stageMessages`; the model just needed to be told it could
send it.

The change is two string appends in `src/tool-calls.mjs`. The four existing
Phase 220 sentinel tests were updated to assert the STAGED_DONE text is present
in staged-mode messages.

## Fix 2: Path dedup in StagedProposalTooLargeError

Phase-222 dogfooding run 3 hit a false positive: stage 7 received a
`StagedProposalTooLargeError` for touching 10 paths when the limit is 8. The
actual unique file count was 6 — the model proposed patches to `db.mjs` and
`upload.mjs` twice each in a repair pass, and `proposalPaths` collected all
10 mentions.

The check was using `paths.length > maxStageWrites` where `paths` is the flat
concatenation of `files.map(f => f.path)` and `patches.map(p => p.path)`. A
file written once and then patched counts twice. A file patched in two overlapping
hunks counts twice again.

The fix introduces `uniquePaths`:

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

The `paths` variable (non-deduped) is preserved for the `paths.length === 0`
check immediately below — that check tests for zero progress, and a duplicate
write is still a write. Only the limit check uses `uniquePaths`.

Two new tests verify the boundary:
1. 9 total ops on 6 unique paths: uniquePaths.length = 6 <= 8, no error.
2. 9 total ops on 9 unique paths: uniquePaths.length = 9 > 8, StagedProposalTooLargeError.

The first test includes 3 duplicate path entries in the `files` array (3 of 6
paths appear twice). The deduplication allows all writes to proceed — last write
wins per path, the pipeline applies 9 entries but only 6 unique files land on disk.

## Fix 3: FTS5 MATCH syntax and createDatabase factory in lang:node skill

Phase-222 dogfooding run 3 produced `src/db.mjs` with two separate bugs that
neither existing skill directives nor existing pitfall entries caught.

**FTS5 alias error**: the generated query was:

```sql
SELECT f.rowid, f.title FROM articles_fts f WHERE f MATCH ?
```

SQLite's FTS5 MATCH operator requires the virtual table name in the WHERE clause,
not a column alias. `WHERE f MATCH ?` produces "fts5: syntax error near '.'".
The correct form is `WHERE articles_fts MATCH ?`. The skill now includes an
explicit wrong/correct pair so the model has a direct pattern to match against.

**Module-scope database with file path**: the generated code was:

```js
const db = new DatabaseSync('data.sqlite');
```

at module scope in `db.mjs`. When three test files all import `db.mjs`, they
share the same `DatabaseSync` handle to `data.sqlite`. The second import gets
"database is locked", and any test that checks "returns empty array initially"
fails on second run because the file-based database persists state.

The existing `SQLite in tests` pitfall in the skill covers the test side
(use `:memory:` in test files). It did not cover the module side — that the
module itself should accept a `path` argument defaulting to `':memory:'`:

```js
export function createDatabase(path = ':memory:') {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE IF NOT EXISTS items (...)`);
    return db;
}
```

This factory pattern lets tests call `createDatabase(':memory:')` while
production code calls `createDatabase('/var/data/app.sqlite')`. The skill
now encodes both the FTS5 pitfall and the factory pattern as named entries
with correct and incorrect code examples.

After editing `SKILL.md`, `npm run build-skills` rebuilt `src/builtin-skills.json`.
The two new entries added roughly 640 chars to the auto-mode prompt (9115 chars,
up from ~8078). The budget guard limits were raised: auto mode 8500 → 9500,
native mode 7200 → 8500, ESM-block test 8500 → 9500.
