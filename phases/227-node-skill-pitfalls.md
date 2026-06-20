# Phase 227 — lang:node Skill Pitfalls From 224–226 Dogfooding

## Goal

Add three named pitfall entries to the **`lang:node` builtin skill**
(`src/builtin-skills/languages/node/SKILL.md`) to address recurring qwen3.6
code-quality bugs found across phases 224–226 and the final-audit dogfood. These
are deterministic skill-content additions whose only goal is to improve
kodr-generated **example quality** — the project's measurement goal. No harness
behaviour changes.

The three pitfalls:

1. **node:sqlite import name** — the export is `DatabaseSync`, NOT `Database`.
   `import { Database } from 'node:sqlite'` is a parse/runtime failure. The skill
   already *uses* `DatabaseSync` in its examples but never explicitly names this
   as a pitfall. Goes in `## node:sqlite pitfalls (Node.js 24)`.
2. **Check response status / content-type before `JSON.parse` in integration
   tests** — a test that does `JSON.parse(await res.text())` (or `await
   res.json()`) on an error response gets an HTML 404 page and throws
   `SyntaxError: Unexpected token '<', "<!DOCTYPE "...`. Assert `res.status` /
   `res.ok` (and/or content-type) before parsing. Goes in `## HTTP integration
   test patterns`.
3. **No module-scope side effects** — generalize the existing listen-guard rule:
   do not run `createDatabase()` / `createServer()` / bootstrap code at import
   time; put all side-effectful startup behind the
   `import.meta.url === \`file://${process.argv[1]}\`` guard so importing the
   module for tests has no effect. Goes in `## HTTP integration test patterns` as
   a **new sibling subsection** (see decision below).

## Why this is next

These three bugs are not hypothetical — they are recorded, recurring qwen3.6
defects from four consecutive live staged runs:

- `process/failures.jsonl` `225-dogfood`: model bugs included the wrong
  `node:sqlite` import (`Database` vs `DatabaseSync`) and module-scope side
  effects.
- `process/failures.jsonl` `226-dogfood`: "qwen tends to write integration tests
  that JSON.parse a response without checking status/content-type, so an HTML
  error page surfaces as a JSON SyntaxError." (`ok:false` was this generated-test
  defect, not a harness bug.)
- `process/failures.jsonl` `224-dogfood` / `final-audit-dogfood`: confirm the
  mechanical staged arms (224/225/226) are done and dogfood-validated, so the
  remaining cheap, high-leverage work is example quality, not loop control.

Naming these three pitfalls in the skill is cheap, deterministic to add, fully
unit-testable with no live model, and directly targets the project's measurement
goal. It follows the exact precedent of the phase-218/223 SQLite skill entries.

### Decision: extend vs. add a sibling for pitfall (3)

Pitfall (3) generalizes the existing **Server listen guard** subsection. **Add a
new sibling subsection `Module-scope side effects`** rather than rewriting the
listen guard. Why:

- The listen guard is a precise, well-worn entry with its own correct/wrong
  example and a paired "start the server in `before()`" snippet. Rewriting it to
  be "general" risks blurring a sharp rule and would force re-touching the tests
  snippet that immediately follows it.
- The generalization (no `createDatabase()` / bootstrap at import) is a distinct,
  nameable rule the model violates independently of the listen call (the
  `225-dogfood` "module-scope side effects" note is about `createDatabase()`, not
  `app.listen()`).
- A sibling entry reads cleanly: the listen guard becomes the canonical *example*
  of the broader rule, and the new entry references it instead of duplicating its
  code. **Do NOT duplicate the listen-guard code block.**

## Changes

### 1. `src/builtin-skills/languages/node/SKILL.md` — pitfall (a): node:sqlite import name

In `## node:sqlite pitfalls (Node.js 24)`, add a new entry as the **first** entry
of the section (immediately after the heading and its blank line, **before** the
existing `**BigInt bind**` entry). Naming the import first is logical — it is the
very first thing a file gets wrong. Exact content to add:

````md
**Import name** — the `node:sqlite` export is `DatabaseSync`, not `Database`.
`import { Database } from 'node:sqlite'` fails (`Database` is undefined; `new
Database(...)` throws `TypeError: Database is not a constructor`). Import the real
name:

```js
// Wrong — there is no `Database` export
import { Database } from 'node:sqlite';

// Correct
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
```
````

### 2. `src/builtin-skills/languages/node/SKILL.md` — pitfall (b): check status before JSON.parse

In `## HTTP integration test patterns`, add a new entry **after** the
`**Server startup port**` entry (the last entry, ending at its
`server.listen(port, ...)` snippet) and **before** the `## busboy v1` heading.
Exact content to add:

````md
**Check status before parsing JSON** — assert `res.ok` / `res.status` (and, when
unsure, the `content-type`) before `JSON.parse(await res.text())` or `await
res.json()`. A 404/500 returns an HTML error page, so parsing it throws
`SyntaxError: Unexpected token '<', "<!DOCTYPE "...` and masks the real failure
(the wrong status) behind a parse error:

```js
// Wrong — parses an HTML 404 page, throws SyntaxError: Unexpected token '<'
const res = await fetch(`http://localhost:${port}/items/999`);
const body = await res.json();

// Correct — assert status first; only parse JSON on a JSON response
const res = await fetch(`http://localhost:${port}/items/999`);
assert.equal(res.status, 404);
if (res.ok) {
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const body = await res.json();
}
```
````

### 3. `src/builtin-skills/languages/node/SKILL.md` — pitfall (c): no module-scope side effects

In `## HTTP integration test patterns`, add a new entry **immediately after** the
`**Server listen guard**` subsection — after its paired "In tests, start the
server explicitly in `before()`:" code block and **before** the `**Server
teardown**` entry. Placing it right after the listen guard lets it reference that
block as the canonical example. Exact content to add (it references the listen
guard; it does NOT repeat it):

````md
**Module-scope side effects** — the listen guard above is one instance of a
general rule: run no side-effectful startup at import time. Do not call
`createDatabase()`, `createServer()`, `app.listen()`, or any bootstrap at module
scope — only define and export. Importing the module for tests must do nothing
observable (no DB file opened, no port bound). Put every side effect behind the
same `import.meta.url` guard so it fires only when the file is run directly:

```js
// db.mjs / server.mjs — export factories; run nothing on import
export function createDatabase(path = ':memory:') { /* ... */ }
export const app = express();

// Only this block runs side effects, and only when executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const db = createDatabase(process.env.DB_PATH ?? 'data.sqlite');
  const port = parseInt(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Listening on ${port}`));
}
```
````

Do NOT re-add the standalone listen-guard `export let server;` block — it already
lives in the **Server listen guard** entry directly above.

### 4. Regenerate the inlined JSON bundle

`src/builtin-skills.json` inlines each skill's `body`. After editing SKILL.md,
run `npm run build-skills`. This rewrites `src/builtin-skills.json` from the
SKILL.md files. `npm run check` runs `build-skills -- --check`, which **fails** if
the JSON is out of sync, so this step is mandatory. Commit both the SKILL.md and
the regenerated JSON.

### 5. `test/system-env.test.mjs` — raise the three char-budget guards (REQUIRED)

The three new entries add roughly 700–1100 chars to the lang:node body (currently
5775 chars). Three prompt-budget guard tests in `test/system-env.test.mjs`
currently have only ~390–465 chars of headroom and **will fail** without raising
their limits:

- `'standard Node/ESM greenfield system message stays under 6000 chars (auto
  mode)'` (~line 355): assert limit currently **9500** (actual ~9110).
- `'native mode stays under 5000 chars (Node/ESM workspace)'` (~line 411): assert
  limit currently **8500** (actual ~8035).
- `'prompt budget guard still holds with ESM block (Node workspace under 6000
  chars)'` (~line 808): assert limit currently **9500** (actual ~9108).

Raise each limit with clear headroom (suggest **10500** for the two 9500 guards
and **9500** for the 8500 guard — ~+1000 each), update both the `assert.ok(...)`
limit and the message string, and **add a phase-227 comment line** to each
guard, matching the phase-218/223 style, e.g.:

```
// Phase 227 added node:sqlite import-name, check-status-before-parse, and
// module-scope-side-effects pitfalls; ~9.8K chars. Limit raised to 10500.
```

Do not lower any limit. The `'non-Node workspace stays under 3500 chars'` guard
(~line 385) is unaffected (no ESM block) — leave it. After editing, re-run the
suite to confirm the new actual counts sit comfortably under the raised limits.

## Tests

All deterministic, no live model. Add to `test/builtin-skills.test.mjs`, inside
the existing `describe('builtin skills bundle', ...)` block, using
`getBuiltinSkill('lang:node')` and `assert.match` on `.body` (file's existing
convention). The existing `it('build-skills --check passes against the committed
JSON')` test already covers JSON/SKILL.md parity — do **not** add a second parity
test. Add three new `it(...)` cases:

### `it('lang:node names the node:sqlite import as DatabaseSync, not Database')`

```js
const { body } = getBuiltinSkill('lang:node');
assert.match(body, /import \{ Database \} from 'node:sqlite'/);
assert.match(body, /DatabaseSync/);
assert.match(body, /not `Database`|not a constructor/i);
```

### `it('lang:node warns to check response status before JSON.parse')`

```js
const { body } = getBuiltinSkill('lang:node');
assert.match(body, /Check status before parsing JSON/);
assert.match(body, /Unexpected token '<'/);
assert.match(body, /res\.status|res\.ok/);
```

### `it('lang:node bans module-scope side effects')`

```js
const { body } = getBuiltinSkill('lang:node');
assert.match(body, /Module-scope side effects/);
assert.match(body, /createDatabase\(\)/);
assert.match(body, /import\.meta\.url/);
```

Regex stability notes:
- Anchor on the exact bold headings (`Check status before parsing JSON`,
  `Module-scope side effects`) and on literal code tokens
  (`import { Database } from 'node:sqlite'`, `Unexpected token '<'`,
  `import.meta.url`) — load-bearing content this phase introduces verbatim, so
  they will not drift on wording polish.
- `import.meta.url` and `createDatabase()` already appear elsewhere (listen guard
  / createDatabase factory), so each test pairs them with the new heading to pin
  the new entry specifically. Keep that pairing.

## Done criteria

- [x] Pitfall (a) added to `## node:sqlite pitfalls (Node.js 24)` (first entry,
      wrong-vs-correct, names `DatabaseSync` not `Database`).
- [x] Pitfall (b) added to `## HTTP integration test patterns` (after `**Server
      startup port**`, wrong-vs-correct, `Unexpected token '<'`).
- [x] Pitfall (c) added as a new `**Module-scope side effects**` sibling right
      after the listen-guard entry; references the listen guard, does **not**
      duplicate its code block.
- [x] `npm run build-skills` run; `src/builtin-skills.json` regenerated and
      committed alongside the SKILL.md.
- [x] Three new regex `it(...)` cases added to `test/builtin-skills.test.mjs`
      (exact regexes above); no second parity test added.
- [x] The three prompt-budget guards in `test/system-env.test.mjs` have their
      limits raised with a phase-227 comment line each (no limit lowered).
- [x] `npm run format` clean.
- [x] `npm run test` — full suite passes (new regex tests, pre-existing
      `build-skills --check` test, raised budget guards).
- [x] `npm run check` clean (covers `node --check`, `cversion --check`,
      `build-skills --check` parity).
- [x] `process/decisions.jsonl` entry: the three pitfalls; the extend-vs-sibling
      decision for (c) and why; the budget-guard raises; reference `failures.jsonl`
      `224-dogfood` / `225-dogfood` / `226-dogfood` / `final-audit-dogfood`.
- [x] Blog post `blog/227-node-skill-pitfalls.md` (the four-run dogfood evidence +
      the example-quality framing).
- [x] `NEXT.md` FIFO: delete the shipped **"lang:node skill pitfalls from 224–226
      dogfooding"** candidate; update the `## Current frontier` note to phase 227.
- [x] `roadmap.md`: add `- [x] 227 lang:node Skill Pitfalls From 224–226
      Dogfooding` after the `- [x] 226 ...` line.
- [x] `package.json` version bumped to `0.0.227` (`cversion --check` enforces
      package.json == max roadmap phase; do both in the same commit).
- [ ] Commit (small, focused; do **not** push).

## Risks / things to watch

- **Budget-guard failures are the #1 trap.** Content-only phase, but it WILL break
  three char-budget tests in `test/system-env.test.mjs` (headroom only ~390–465
  chars). Raising those limits (step 5) is required, not optional. Verify with the
  full suite, not just `test/builtin-skills.test.mjs`.
- **`build-skills --check` parity.** Forgetting `npm run build-skills` leaves the
  inlined JSON stale and `npm run check` fails. Regenerate and commit the JSON
  with the SKILL.md.
- **cversion coupling.** Roadmap `- [x] 227` line without the `package.json`
  bump (or vice versa) fails `cversion --check`. Do both in one commit.
- **`renderLanguageGuidanceBlock` single-source test.** `test/system-env.test.mjs`
  asserts `renderLanguageGuidanceBlock({ isNodeEsm: true })` equals
  `getBuiltinSkill('lang:node').body.trim()` — stays green once the JSON is
  rebuilt, and is a reminder that SKILL.md is the single source of truth: never
  hand-edit the JSON.
- **Don't duplicate the listen guard** (bloats the body, worsens budget headroom,
  reads redundant).
