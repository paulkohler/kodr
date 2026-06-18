# Example: CLI Task Manager

A two-session CLI task manager using `node:sqlite`. Session 1 builds the core
CRUD + a formatted table view with ANSI colour badges. Session 2 adds priority
filtering, due-date support, and a summary command. Designed to exercise:

- `node:sqlite` (DatabaseSync, prepare/run/all)
- ANSI-aware `formatTable` that uses `visibleWidth`/`truncateVisible`
- `protectExisting`: Session 2 must patch Session 1 files, not rewrite them
- `--test-timeout`: any hanging test fails fast

## File structure after Session 1

```
package.json          — {"type":"module"}, no deps
src/db.mjs            — openDb(path), runMigrations(db)
src/tasks.mjs         — createTask, getTask, listTasks, completeTask, deleteTask
src/format.mjs        — statusBadge(status), formatTable(rows, cols)
src/cli.mjs           — argv dispatch: add / list / done / rm
test/tasks.test.mjs   — node:test CRUD tests
test/format.test.mjs  — visibleWidth/truncateVisible + formatTable tests
```

## File structure after Session 2

```
(all Session 1 files patched, not replaced)
src/tasks.mjs         — adds: filterByPriority, filterByDue, taskSummary
src/cli.mjs           — adds: --priority flag on list, summary command
test/tasks.test.mjs   — adds: filter + summary tests
```

## Session 1 prompt

```
Build a CLI task manager using node:sqlite (Node 24 built-in). No npm dependencies.

package.json — {"type":"module"} only, no scripts, no deps.

src/db.mjs — import { DatabaseSync } from 'node:sqlite'.
  Export function openDb(path): returns new DatabaseSync(path || ':memory:').
  Export function runMigrations(db): executes:
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )

src/tasks.mjs — import { openDb, runMigrations } from './db.mjs'.
  DB_PATH = process.env.TASK_DB || 'tasks.db'.
  Export function createTask(title, priority='medium'): INSERT, return {id,title,status,priority}.
  Export function getTask(id): SELECT by id, return row or null.
  Export function listTasks(opts={}): SELECT all, ORDER BY created_at DESC, id DESC.
  Export function completeTask(id): UPDATE status='done', return {changes}.
  Export function deleteTask(id): DELETE by id, return {changes}.

src/format.mjs — No imports.
  Export function statusBadge(status): returns '\x1B[32m[done]\x1B[0m' for done,
    '\x1B[33m[open]\x1B[0m' for open, '\x1B[31m[?]\x1B[0m' for unknown.

  ANSI truncation (copy exactly):
    const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/gu;
    function visibleWidth(str) { return str.replace(ANSI_RE, '').length; }
    function truncateVisible(str, width) {
      if (visibleWidth(str) <= width) return str;
      let vis = 0, result = '', i = 0;
      while (i < str.length) {
        const m = /^\x1B\[[0-9;]*[A-Za-z]/u.exec(str.slice(i));
        if (m) { if (vis < width) result += m[0]; i += m[0].length; }
        else { if (vis >= width) break; result += str[i++]; vis++; }
      }
      return result;
    }
  Export visibleWidth and truncateVisible.

  Export function formatTable(rows, cols):
    cols is [{key, label, width}].
    Print header row: cols.map(c => c.label.padEnd(c.width)).join('  ')
    Print separator: cols.map(c => '-'.repeat(c.width)).join('  ')
    For each row, print cols.map(c => truncateVisible(String(row[c.key]??''), c.width).padEnd(c.width)).join('  ')
    Note: padEnd after truncateVisible uses raw length, which is correct because
    truncateVisible produces a string whose raw length equals its visible width
    (no trailing ANSI codes). But if a cell contains ANSI codes (like statusBadge),
    padEnd will pad by raw length which is wrong. For ANSI cells, compute visible
    padding: append spaces until visibleWidth(cell) === c.width.
    Return the full table string.

src/cli.mjs — import from './tasks.mjs', './format.mjs'.
  Parse process.argv. Commands:
    add <title> [--priority low|medium|high]: createTask, print "Created #<id>".
    list: listTasks, print formatTable with cols:
      [{key:'id',label:'ID',width:4},{key:'status',label:'STATUS',width:12},
       {key:'priority',label:'PRI',width:8},{key:'title',label:'TITLE',width:40}]
      Use statusBadge for the status cell.
    done <id>: completeTask, print "Done #<id>".
    rm <id>: deleteTask, print "Deleted #<id>".

test/tasks.test.mjs — import { test, describe } from 'node:test'; import assert.
  Use an in-memory DB (TASK_DB not set → ':memory:').
  Before each describe block: openDb(':memory:'), runMigrations.
  Tests: createTask returns {id,title,status,priority}; getTask returns row;
    listTasks returns array in DESC order; completeTask sets status done;
    deleteTask removes row.

test/format.test.mjs — import { test, describe } from 'node:test'; import assert.
  Test visibleWidth: plain string, ANSI-coloured string.
  Test truncateVisible: plain truncation, ANSI-coloured truncation preserves codes.
  Test formatTable: 2 rows, verify header line present, separator present,
    cell values present in output.
```

## Session 2 prompt

```
The task manager core is done and tests pass. Add priority filtering and a summary.

Extend src/tasks.mjs (patch, do not rewrite):
  Add: export function filterByPriority(tasks, priority): returns tasks.filter(t => t.priority === priority).
  Add: export function taskSummary(db): returns {total, open, done, highPriority}
    where highPriority = count of open tasks with priority='high'.

Extend src/cli.mjs (patch, do not rewrite):
  Add --priority <level> option to list command: filter results before printing.
  Add summary command: print taskSummary as formatted lines.

Extend test/tasks.test.mjs (patch, do not rewrite):
  Add tests: filterByPriority returns only matching tasks;
    taskSummary returns correct counts.
```

## What to watch for

- Does Session 1 produce correct ANSI-aware `formatTable`?
- Does Session 2 use `patches[]` for all three files (protectExisting in effect)?
- Does the express-async-route sensor stay silent (no Express in this example)?
- Does `--test-timeout=10000` prevent any sqlite test from hanging?

## Run commands

```sh
mkdir -p ~/src/kodr-testing/phase-204/task-manager-1
cd ~/src/kodr-testing/phase-204/task-manager-1
kodr run --yes --heal --test "node --test" --max-turns 25 -p "<session 1 prompt>"

# Session 2
kodr run --yes --heal --test "node --test" --max-turns 20 -p "<session 2 prompt>"
```
