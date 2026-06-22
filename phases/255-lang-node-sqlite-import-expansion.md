# Phase 255: lang:node Skill — node:sqlite Import Wrong-Form Expansion

## Motivation

Phase-253 and 254 dogfoods both received D grades because the model cycled
through three wrong import forms before hitting max_turns:

- `import { open } from 'node:sqlite'` (no such export → TypeError: open is not a function)
- `import sqlite from 'node:sqlite'; new sqlite.Database(...)` (no default export → sqlite.Database is not a constructor)
- `import { Database } from 'node:sqlite'` (already in the skill — but only this one wrong form was covered)

The model also used `await db.exec()` / `await db.run()` throughout — node:sqlite
has no async API. `await` on a synchronous return silently wraps the value in a
resolved Promise; no error is raised but the code implies async semantics that
don't exist.

## Design

Single-file edit to `src/builtin-skills/languages/node/SKILL.md` plus test and
size-limit updates. No runtime code changes.

### 1. Where to change

- **Extend** the existing `**Import name**` pitfall to show all three wrong forms
- **Insert** a new `**node:sqlite is synchronous**` pitfall immediately after
  Import name, before BigInt bind

### 2. Exact changes to SKILL.md

#### 2a. Replace Import name pitfall body

Replace everything from `**Import name**` through the closing fence with:

```md
**Import name** — the only `node:sqlite` export is `DatabaseSync`. Three wrong
import forms produce runtime errors:

```js
// Wrong A — there is no `Database` export
import { Database } from 'node:sqlite';
// TypeError: Database is not a constructor

// Wrong B — there is no `open` export
import { open } from 'node:sqlite';
// TypeError: open is not a function

// Wrong C — no default export; sqlite.Database does not exist
import sqlite from 'node:sqlite';
new sqlite.Database(':memory:');
// TypeError: sqlite.Database is not a constructor

// Correct
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
```
```

#### 2b. Insert synchronous pitfall after Import name, before BigInt bind

```md
**node:sqlite is synchronous** — every `DatabaseSync` method is blocking and
synchronous. `prepare()`, `exec()`, and the `StatementSync` methods (`all()`,
`get()`, `run()`) have no async form. `await`-ing them does nothing — it wraps
the already-resolved value in a Promise and silently returns it:

```js
// Wrong — await does nothing; node:sqlite has no async API
const rows = await db.prepare('SELECT * FROM notes').all();
await db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');

// Correct — synchronous, use the return value directly
const rows = db.prepare('SELECT * FROM notes').all();
db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
```
```

### 3. Test changes — `test/builtin-skills.test.mjs`

Update the existing import-name test to cover all three wrong forms:

```js
it('lang:node names the node:sqlite import as DatabaseSync, not Database', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /import \{ Database \} from 'node:sqlite'/);
    assert.match(body, /import \{ open \} from 'node:sqlite'/);
    assert.match(body, /import sqlite from 'node:sqlite'/);
    assert.match(body, /sqlite\.Database is not a constructor/);
    assert.match(body, /DatabaseSync/);
});
```

Add new synchronous-API test immediately after:

```js
it('lang:node warns that node:sqlite is synchronous — no await', () => {
    const { body } = getBuiltinSkill('lang:node');
    assert.match(body, /node:sqlite is synchronous/);
    assert.match(body, /await db\.prepare/);
    assert.match(body, /await.*does nothing/i);
    assert.match(body, /db\.prepare\('SELECT/);
    assert.match(body, /db\.exec\(/);
});
```

### 4. Size-limit adjustments — `test/system-env.test.mjs`

After editing SKILL.md, run `npm test` — the three size guards will fail with
exact measured values. Set each ceiling to the next clean 500 above the measured
value. Add a dated `// Phase 255` comment on each guard line.

### 5. NEXT.md and roadmap

- Delete `### lang:node node:sqlite import wrong-form expansion` from `NEXT.md`
- Update `## Current frontier` to mention phase 255
- Mark `- [x] 255 lang:node node:sqlite Import Wrong-Form Expansion` in `roadmap.md`

## Done criteria

- [x] `**Import name**` pitfall extended to show all three wrong forms.
- [x] New `**node:sqlite is synchronous**` pitfall inserted after Import name,
      before BigInt bind. Contains "await does nothing", wrong await forms, and
      correct sync forms.
- [x] Updated import-name test with 5 assertions covering all three wrong forms.
- [x] New `'lang:node warns that node:sqlite is synchronous — no await'` test
      passes with 5 assertions.
- [x] Three prompt-budget guards raised with phase-255 dated comments.
- [x] `npm run format`, full test suite, and `npm run check` clean.
- [x] `process/decisions.jsonl` records provenance (phase-253/254 dogfood).
- [x] Blog post `blog/255-lang-node-sqlite-import-expansion.md` added.
- [x] NEXT.md entry deleted; frontier updated to 255.
- [x] Roadmap line checked.
- [x] Commit captures the phase.
