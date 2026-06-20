# Phase 227: lang:node Skill Pitfalls From 224–226 Dogfooding

Four consecutive live staged runs (phases 224, 225, 226, and a final audit)
against qwen3.6 on the same task class — Express + node:sqlite notes API —
surfaced the same three code-quality bugs every time. Each run broke for
different mechanical reasons in the harness, but the generated code underneath
carried the same pattern of errors. Phase 227 encodes them as named pitfall
entries in the `lang:node` builtin skill.

## The four-run record

**225-dogfood** was the most direct indictment. The model emitted:

```js
import { Database } from 'node:sqlite';
const db = new Database(':memory:');
```

`Database` is not an export of `node:sqlite`. `DatabaseSync` is. The call
throws `TypeError: Database is not a constructor` before any test runs. The
same run also opened a database connection at module scope in `db.mjs` rather
than behind an `import.meta.url` guard, meaning every test file that imported
the module opened a real file-based DB on load — "database is locked" and
dirty-state failures on the second test file through.

**226-dogfood** added the third defect. The model wrote:

```js
const res = await fetch(`http://localhost:${port}/items/999`);
const body = await res.json();
assert.equal(body.message, 'Not found');
```

The 404 route was not registered, so the server returned an HTML 404 page from
Node's default error handler. `res.json()` threw `SyntaxError: Unexpected token
'<', "<!DOCTYPE "...`. The test reported a parse error, not a status failure.
The real failure (404 with no JSON body) was invisible.

**final-audit-dogfood** repeated the JSON-parse pattern. The note in
`failures.jsonl` reads: "qwen tends to write integration tests that JSON.parse
a response without checking status/content-type, so an HTML error page surfaces
as a JSON SyntaxError." That "tends to" is the signal: it is not random. The
model has a systematic preference for parsing before checking.

**224-dogfood** confirmed the module-scope pattern: the phase-224 auto-advance
arm never fired because the model used `edit_file` patches on already-written
files, so the harness stall was different, but the `createDatabase()` at module
scope was there in the generated output.

## The fix: three named pitfalls

### Import name

Goes at the top of `## node:sqlite pitfalls (Node.js 24)`, before the existing
BigInt bind entry. Naming the import wrong is the very first thing a file can
get wrong. Placing it first follows the same logic as the section's ordering —
most fundamental mistake first.

The entry calls out both the observable symptoms: `Database is undefined` and
`new Database(...)` throws `TypeError: Database is not a constructor`. The
correct name `DatabaseSync` was already used in every existing example in the
skill; this entry is the first to explicitly flag the wrong name as a named
pitfall.

### Check status before parsing JSON

Goes after the `**Server startup port**` entry in `## HTTP integration test
patterns`, before the `## busboy v1` heading. The wrong pattern is two lines; the
correct pattern is the same two lines with `assert.equal(res.status, ...)` inserted
before the parse call and the `res.json()` guarded inside `if (res.ok)`.

The entry anchors on the literal error string `SyntaxError: Unexpected token '<',
"<!DOCTYPE "...` — load-bearing prose this phase introduces verbatim. Tests pin on
that exact string, so the entry can't drift to a softened wording without
breaking a test.

### Module-scope side effects

The plan specified adding a new `**Module-scope side effects**` sibling
immediately after the listen guard's `before()` code block, rather than
rewriting the listen guard. The rationale for keeping them separate:

The listen guard is a precise, well-worn entry with its own correct/wrong example
and a paired "start the server in `before()`:" snippet. The 225-dogfood failure
was `createDatabase()` at module scope, which fires on import independently of
any `app.listen()` call. Rewriting the listen guard to be "general" would blur
both rules and risk breaking the test that pairs the listen-guard snippet with
the before() pattern. A sibling entry references the listen guard as the
canonical example of the broader rule without duplicating its code.

The new entry does not repeat `export let server;` or the guarded `app.listen()`
block — those live in the entry directly above it.

## Budget guards: more growth than expected

The plan estimated 700–1100 chars of growth and suggested raising the budget
limits by ~1000 each (9500 → 10500, 8500 → 9500). The actual body grew from
5775 to 7977 chars — 2202 chars — because three entries with correct/wrong code
blocks are larger in aggregate than any single-entry phase.

The three prompt-length guards in `test/system-env.test.mjs` measure the actual
rendered system prompt (not just the skill body), so the deltas are slightly
different:

| Guard | Before | After | Limit raised to |
|---|---|---|---|
| Auto mode greenfield | ~9115 | ~11317 | 12000 |
| Native mode | ~8040 | ~10242 | 11000 |
| ESM block (qwen model) | ~9113 | ~11315 | 12000 |

Each limit was raised with a phase-227 comment line matching the phase-218/223
style. The non-Node 3500-char guard was untouched.

## Tests

Three new regex `it(...)` cases in `test/builtin-skills.test.mjs`:

- `lang:node names the node:sqlite import as DatabaseSync, not Database` —
  anchors on the verbatim `import { Database } from 'node:sqlite'` wrong-example
  line and on `not a constructor`.
- `lang:node warns to check response status before JSON.parse` — anchors on the
  heading `Check status before parsing JSON` and on the literal `Unexpected token
  '<'`.
- `lang:node bans module-scope side effects` — anchors on `Module-scope side
  effects`, `createDatabase()`, and `import.meta.url`.

Test count: 1814 → 1817.
