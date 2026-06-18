# Example Idea: Issue Tracker CLI

A GitHub-style issue tracker built as a Node.js CLI using only built-in modules:
`node:sqlite` for persistence, `node:readline` for input, ANSI escape codes for
rich terminal output. Two kodr sessions: Session 1 builds the schema and CRUD
commands; Session 2 adds search, filtering, and formatted table output.

## Areas exercised

- `node:sqlite` (Node 24 native) schema creation and prepared statements
- Multi-command CLI dispatching without external packages
- Rich terminal output (ANSI table, colour, status badges) without a library
- Session 2 builds on Session 1 artifacts via workspace context
- Heal loop pressure: SQLite API differences from `better-sqlite3`, ESM import paths

## File structure after Session 1

```
src/db.mjs        — DatabaseSync setup, openDb(path), runMigrations()
src/issues.mjs    — createIssue, getIssue, listIssues, closeIssue, addComment, listComments
src/cli.mjs       — argv dispatch: issue create | show | list | close | comment
package.json      — ESM, no dependencies
test/issues.test.mjs — node:test covering full CRUD lifecycle
```

## File structure after Session 2

```
src/db.mjs        (unchanged)
src/issues.mjs    + searchIssues(db, term), filterIssues(db, { status })
src/format.mjs    — formatTable(rows, cols), statusBadge(status), formatDate(ts)
src/cli.mjs       + issue search <term>  |  issue list --status open|closed|all
test/issues.test.mjs  (must still pass)
test/format.test.mjs  — tests for formatTable, statusBadge
```

## Session 1 prompt

```
Build a GitHub-style issue tracker CLI in Node.js using only built-in modules.

package.json — {"type":"module","bin":{"issue":"./src/cli.mjs"}}, no dependencies.

src/db.mjs — import DatabaseSync from 'node:sqlite'. Export function openDb(path):
returns a new DatabaseSync(path). Export function runMigrations(db): creates two
tables if they don't exist:
  issues(id integer primary key, title text not null, body text, status text not null
         default 'open', created_at integer not null)
  comments(id integer primary key, issue_id integer not null references issues(id),
           body text not null, created_at integer not null)

src/issues.mjs — import openDb, runMigrations. Export:
  createIssue(db, title, body): inserts into issues with Date.now() timestamp, returns row
  getIssue(db, id): returns issue row or null
  listIssues(db): returns all issues ordered by created_at desc
  closeIssue(db, id): sets status='closed', returns updated row or null if not found
  addComment(db, issueId, body): inserts comment, returns row
  listComments(db, issueId): returns comments for issue ordered by created_at

src/cli.mjs — #!/usr/bin/env node
Parse process.argv from index 2. Dispatch:
  issue create <title> [body]  — prints "Created #<id>: <title>"
  issue show <id>              — prints title, status, body, then each comment
  issue list                   — prints each issue as "#<id> [<status>] <title>"
  issue close <id>             — prints "Closed #<id>"
  issue comment <id> <body>    — prints "Comment added to #<id>"
  (unknown command)            — prints usage and exits 1
Database file: process.env.ISSUE_DB || '.issues.db'. Call runMigrations(db) before
every command. db.close() after. Make the file executable.

test/issues.test.mjs — node:test tests using a fresh in-memory database (':memory:')
for each test. Call runMigrations(db) in beforeEach. Tests:
  - createIssue returns {id, title, status:'open'}
  - getIssue returns null for missing id
  - listIssues returns newest first
  - closeIssue changes status to 'closed' and returns the row
  - addComment and listComments round-trip
  - closeIssue returns null for unknown id
```

## Session 2 prompt (fresh run in same workspace)

```
The issue tracker core is done and tests pass. Extend it:

src/issues.mjs — add:
  searchIssues(db, term): full-text search on title and body using SQL LIKE '%term%',
    returns matching issues ordered by created_at desc
  filterIssues(db, opts): opts.status ('open'|'closed'|'all', default 'open'),
    returns filtered issues

src/format.mjs — export:
  statusBadge(status): returns '[open]' in green ANSI or '[closed]' in grey
  formatDate(tsMs): returns ISO date string (YYYY-MM-DD)
  formatTable(rows, columns): columns = [{key, label, width}]. Returns a string
    with a header row, separator, and one line per row. Truncate cell values to
    column width. Use ANSI bold for the header row.

src/cli.mjs — update:
  issue list — now uses formatTable; columns: id (4), status badge (10), title (40),
    date (12). Accepts optional --status open|closed|all flag (default open)
  issue search <term> — new command, calls searchIssues, formats with formatTable,
    prints "No results." if empty
  issue show <id> — prefix status with statusBadge, format dates with formatDate

test/issues.test.mjs — add tests for searchIssues and filterIssues (all existing
  tests must still pass).

test/format.test.mjs — node:test tests:
  - statusBadge('open') contains 'open' and an ANSI escape sequence
  - statusBadge('closed') contains 'closed'
  - formatDate(0) returns '1970-01-01'
  - formatTable with 2 rows and 2 columns returns a string with header and separator
```

## What to watch for

- Does the model use `DatabaseSync` correctly? (node:sqlite API differs from better-sqlite3)
- Does `new DatabaseSync(':memory:')` work for test isolation?
- Does Session 2 import from Session 1 files without guessing wrong paths?
- Does `formatTable` produce correct truncation with multi-byte content?
- How many heal cycles per session?

## Lessons from the 2026-06-18 trial run (qwen3.6, 32K context)

### Session 1

First run: wrote `src/db.mjs`, `src/issues.mjs`, `test/issues.test.mjs` (4 files) across
34 turns but never wrote `src/cli.mjs`. Final model turn was `finish_reason: tool_calls`
with content `"\n\n"` (2 chars) — harness reported `stopReason: staged` /
`ProposalMissingError`. **The writes were applied successfully despite the error.**

5/6 tests passed. Failing test: `listIssues returns newest first` — two synchronous
inserts share the same `Date.now()` ms, making `ORDER BY created_at DESC`
non-deterministic. Fix: `ORDER BY created_at DESC, id DESC`.

**Root cause of missing cli.mjs**: qwen3.6 is loaded at 32K (`loaded_context_length`),
not the 262K max. With a multi-file task accumulating conversation history, the model
ran out of effective context before finishing all files.

Targeted second pass (shorter prompt + smaller context) completed the job cleanly:
cli.mjs created, ordering fixed, 6/6 tests green.

### Session 2

First pass, all 5 files in one run. Tests passed without a heal cycle.

**ANSI truncation artifact**: `formatTable` pads/truncates cells to `width` chars
treating ANSI escape codes as regular characters. A `statusBadge` like
`\x1b[32m[open]\x1b[0m` has 16 raw chars but only 6 visible chars. When `width:10`
truncates at position 10 it cuts mid-escape, producing visible garbage (`[32m[open`).
The model would need to strip escapes before computing width or skip ANSI chars.
**Not fixed** — this is a model output artifact worth preserving.

### Key learnings

| Observation | Detail |
|-------------|--------|
| 32K context ceiling | Complex 5-file task required 2 runs at 32K; one run at larger context would likely have succeeded |
| Staged exit with applied writes | Files were usable even though harness reported ProposalMissingError |
| node:sqlite API | Model used it correctly — DatabaseSync, prepare/run/get/all, lastInsertRowid |
| Date.now() collision in tests | Rapid synchronous inserts share ms timestamp; tiebreaker by id is the fix |
| ANSI + formatTable | Model doesn't account for invisible escape chars when truncating cells |
| Session 2 context efficiency | Fresh run with only workspace files in context = clean single-pass result |

## Suggested models

qwen3.6 for both sessions. Also interesting to try with gemma-4-26b.

## Run commands

```sh
# Session 1
mkdir -p ~/src/kodr-testing/phase-201/issue-tracker-1
cd ~/src/kodr-testing/phase-201/issue-tracker-1
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 1 prompt>"

# Session 2 (fresh run in same workspace)
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 2 prompt>"

# Smoke test the CLI
ISSUE_DB=test.db node src/cli.mjs create "First issue" "This is the body"
ISSUE_DB=test.db node src/cli.mjs list
ISSUE_DB=test.db node src/cli.mjs search "First"
```
