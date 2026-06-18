# Example: CLI Task Manager (Two Sessions)

A Node.js CLI task manager with SQLite persistence, built across two Kodr sessions.
Uses `node:sqlite` (built-in, no npm). Session 2 extends Session 1 with a priority
filter and a summary command.

**Workspace:** `~/src/kodr-testing/phase-204/task-manager-1`  
**Model:** `qwen/qwen3.6-35b-a3b`

## File structure after Session 1

```
package.json          — {"type":"module","scripts":{"test":"node --test"}}
src/db.mjs            — openDb(path?), runMigrations(db)
src/tasks.mjs         — createTask, getTask, listTasks, completeTask, deleteTask
src/format.mjs        — formatTable(rows, cols) with ANSI-aware truncation
src/cli.mjs           — argv dispatch: create / list / get / complete / delete
test/tasks.test.mjs   — node:test CRUD tests (5 tests, in-memory db)
test/format.test.mjs  — visibleWidth/truncateVisible/formatTable tests
```

## File structure after Session 2

```
(all Session 1 files patched, not replaced)
src/tasks.mjs         — adds: filterByPriority(tasks, priority), taskSummary(db)
src/cli.mjs           — adds: --priority flag on list, summary command
test/tasks.test.mjs   — adds: filterByPriority and taskSummary tests
```

## Session 1 prompt

```
Build a Node.js CLI task manager with SQLite using node:sqlite (built-in, no npm).

src/db.mjs — openDb(dbPath?) returns a DatabaseSync instance opened at dbPath
(default ':memory:'). runMigrations(db) creates the tasks table if absent:
  id INTEGER PRIMARY KEY AUTOINCREMENT
  title TEXT NOT NULL
  priority TEXT NOT NULL DEFAULT 'medium'
  completed INTEGER NOT NULL DEFAULT 0
  created_at TEXT NOT NULL DEFAULT (datetime('now'))

src/tasks.mjs — CRUD functions, all taking db as first argument:
  createTask(db, title, priority='medium') -> task row
  getTask(db, id) -> task row or undefined
  listTasks(db) -> all task rows
  completeTask(db, id) -> updated task row
  deleteTask(db, id) -> RunResult

src/format.mjs — formatTable(rows, cols) renders an aligned ASCII table.
  cols is [{key, label}]. Truncate cells to 30 chars, align columns.

src/cli.mjs — CLI entry point using process.argv.
  Commands: create <title> [priority], list, get <id>, complete <id>, delete <id>
  Uses openDb(process.env.DB_PATH || './tasks.db')

test/tasks.test.mjs — node:test tests for all five functions.
  Use in-memory db for isolation: const db = openDb(':memory:'); runMigrations(db);

package.json — {"type":"module","scripts":{"test":"node --test"}}
```

**Run:**
```sh
cd ~/src/kodr-testing/phase-204/task-manager-1
kodr run --yes --heal --no-tools --test "node --test" --no-inspect-context \
  -p "<session 1 prompt>"
```

**Result:** Run ok. Tokens: ~1,800 / ~2,200. Tests: 5 passing.

## Session 2 prompt

```
Extend the task manager. All files already exist — use patches only.

src/tasks.mjs already has filterByPriority(tasks, priority) at the end.
Add taskSummary after it:

export function taskSummary(db) {
  const rows = listTasks(db);
  const total = rows.length;
  const done = rows.filter(r => r.completed === 1).length;
  const open = total - done;
  const highPriority = rows.filter(r => r.priority === 'high' && r.completed === 0).length;
  return { total, open, done, highPriority };
}

src/cli.mjs — update the import to add filterByPriority and taskSummary.
Add a 'summary' command that prints: Total: N, Open: N, Done: N, High priority: N
In the 'list' command, parse a '--priority <p>' flag from args before calling
listTasks. If present, call filterByPriority(listTasks(db), p) instead.

test/tasks.test.mjs — add tests for filterByPriority and taskSummary.
```

**Run:**
```sh
kodr run --yes --heal --no-tools --test "node --test" --max-turns 20 \
  --no-protect-existing --no-inspect-context -p "<session 2 prompt>"
```

**Result:** Run ok, one heal pass. Tokens: ~3,200 / ~2,400. Tests: 10 passing.

## Notes

- **`--no-inspect-context` required for qwen3.6.** The inspection-aware mode provides
  only selected code chunks. The thinking model then reasons endlessly about the
  incomplete context, exhausts its token budget, and produces empty output. Whole-file
  context via `--no-inspect-context` resolves this. See Phase 205–206 blog posts.
- **`filterByPriority` operates on an array, not the db.** It filters `listTasks(db)`
  output: `filterByPriority(listTasks(db), 'high')`.
- Session 2 used `--no-protect-existing` because all changes were patches (safe: the
  flag only affects the `files[]` block; `patches[]` always apply).
