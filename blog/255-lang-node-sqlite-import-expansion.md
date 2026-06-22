# Phase 255: Three Wrong Ways to Import node:sqlite

Phase 253 and 254 both graded D. The model cycled through import errors for the
entire run and hit `max_turns` before producing working code. The skill already
warned about `import { Database } from 'node:sqlite'` — but that one pitfall
wasn't enough. The model had two more wrong guesses ready to try.

## The three wrong forms

### Wrong A: `{ Database }`

```js
import { Database } from 'node:sqlite';
const db = new Database(':memory:');
// TypeError: Database is not a constructor
```

This is the npm `sqlite3` package's API. The `sqlite3` npm package exports a
`Database` class with a constructor that takes a file path. Node.js 24's built-in
`node:sqlite` is a different module with a different API. When the model reaches
for SQLite it pattern-matches on training data dominated by `sqlite3` npm usage.
The skill already showed this form, but the model reverted to it anyway after an
error recovery cycle.

### Wrong B: `{ open }`

```js
import { open } from 'node:sqlite';
const db = await open(':memory:');
// TypeError: open is not a function
```

This is the `better-sqlite3` community wrapper's async API (also styled after
IndexedDB's `indexedDB.open()`). There is no `open` export in `node:sqlite`. The
model arrived at this form after the `Database` error: it reasoned that if
`Database` was wrong, maybe the module uses a factory function instead of a
constructor. The `open()` pattern exists in enough SQLite wrapper libraries to
make it a plausible guess from training priors.

### Wrong C: default import + `sqlite.Database`

```js
import sqlite from 'node:sqlite';
new sqlite.Database(':memory:');
// TypeError: sqlite.Database is not a constructor
```

After two named-export failures, the model switched to a default import and tried
to namespace the constructor. `node:sqlite` has no default export. This is the
CommonJS interop pattern: `const sqlite = require('sqlite3'); new sqlite.Database(...)`.
The model's recovery heuristic (if named exports fail, try a default namespace)
produced a form it recognised from CJS usage.

## The async error

Alongside the import cycling, both dogfoods used `await` on every DatabaseSync call:

```js
const rows = await db.prepare('SELECT * FROM notes').all();
await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
```

`node:sqlite` is fully synchronous. `DatabaseSync`, `StatementSync`, `all()`,
`get()`, `run()`, `exec()` — none of these return Promises. `await` on a
synchronous return wraps the value in an already-resolved Promise and hands it
back immediately. No error is raised. The code appears to work, but it asserts an
async contract that doesn't exist. The model's choice of the name `DatabaseSync`
versus a hypothetical `DatabaseAsync` did not register as a signal; it wrote
`await` by muscle memory from the overwhelming majority of database access
patterns in its training data.

## Why the model ignores the skill

Both dogfoods graded D even though phase 227 already put `{ Database }` in the
skill. The skill is injected into the system prompt and the model reads it at the
start of the session. But skill guidance competes with training priors — when the
model generates a recovery attempt after an error, it pattern-matches on the error
message against its training data, not against the injected skill. The `Database`
pitfall was present; the model chose its own heuristic instead.

Adding the other two wrong forms to the skill at least makes the pitfall block
comprehensive enough to serve as a reference if the model does consult it. The
`await` pitfall addresses a second independent failure mode.

## Test delta

1961 → 1962 tests. The existing import-name test was extended from 3 assertions to
5 (covering all three wrong forms and the error text). A new `node:sqlite is
synchronous` test adds 5 more assertions in `test/builtin-skills.test.mjs`.

## Size guard update

The two new blocks add roughly 894 chars to the lang:node skill body. Three size
guards in `test/system-env.test.mjs` were updated:

- Node/ESM greenfield (auto): ~20725 → 21619 chars; limit raised to 22000 // Phase 255
- Native mode: ~19632 → 20526 chars; limit raised to 21000 // Phase 255
- ESM block guard: ~20723 → 21617 chars; limit raised to 22000 // Phase 255
