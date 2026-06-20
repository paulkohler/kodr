# Phase 238: lang:node Skill — ESM Cache-Bust Import Does Not Reset Module State

The phase-236 dogfood (`phase-236/uncap-main-1`) produced a clean two-file
generation: `src/inventory.mjs` and `test/inventory.test.mjs`. The harness ran
`node --test` and 5 of 27 assertions failed — counts off by accumulated prior-test
state. The module under test worked fine. The model's tests were broken.

## What the model wrote

The test file defined a helper:

```js
async function freshInventory() {
  const mod = await import('../src/inventory.mjs?t=' + Date.now());
  return mod;
}
```

The intent is clear: append a timestamp query string to the import URL to bypass
any module cache and get a fresh module instance for each test. This is a
reasonable thing to reach for — it's the kind of technique that works in a
browser bundler or a require()-based system.

It does not work in Node.js ESM.

## Why the query string does nothing

Node.js caches ESM modules by canonical file path. When you call
`import('./inventory.mjs?t=1749506000000')` and then
`import('./inventory.mjs?t=1749506001234')`, the runtime resolves both specifiers
to the same `file:///…/src/inventory.mjs` canonical path and returns the same
cached module instance both times.

The result: every call to `freshInventory()` returns the exact same module object
with the exact same module-scope `Map`. State written in test 1 is still present
in test 2. Counts are off by the totals from all prior tests. The 5/27 failures
were counts that had accumulated across tests that were supposed to be isolated.

The model knew it needed isolation — the `freshInventory` helper is evidence of
that intent. It just reached for the wrong mechanism.

## The pitfall class

This belongs to the same family as two entries already in the skill:

**Module-scope side effects** (phase-227): never run `createDatabase()`,
`app.listen()`, or any bootstrap at module scope. The module initializes once,
on first import — every subsequent import of the same module returns the cached
instance. This entry explains why module-scope state persists.

**SQLite in tests** (phase-218): use `:memory:` so each test run starts with a
clean database. A file-path database persists state across test runs.

All three are variations of the same root cause: a module or resource initialized
once, state accumulating because the consumer expects isolation that the runtime
does not provide. The fix is always a factory: construct a fresh instance per test.

## The fix: factory pattern

```js
// inventory.mjs
export function createInventory() {
  const items = new Map(); // fresh Map per call, never module-scope
  return { add(x) { items.set(x.id, x); }, count() { return items.size; } };
}

// inventory.test.mjs
let inv;
beforeEach(() => { inv = createInventory(); });
```

The module-scope `Map` that leaked across tests is gone. Each `beforeEach` call
gets its own clean `Map`. The query-string `freshInventory()` helper is replaced
by a direct `createInventory()` call.

## Where the pitfall entry sits

The new `## Test isolation — no ESM cache-bust re-import` section goes between
the HTTP `**Check status before parsing JSON**` code block and `## busboy v1`.
That placement keeps it adjacent to the module-scope-side-effects entry and the
integration test patterns — all three are about test isolation and resource
lifecycle. The structure mirrors the existing pitfall format: a bold opener
stating the concrete wrong thing, the explanation of why it's wrong, then
wrong/correct code blocks with comments.

## Budget guards: measured and raised

The pitfall section adds one heading, one paragraph, and a three-block code
example (wrong + two correct fragments). That runs to ~700 chars of raw markdown,
which the context packer renders to a somewhat larger delta in the system prompt
because code blocks have surrounding whitespace.

Measurements after regenerating `builtin-skills.json`:

| Guard | Before | After | Limit raised to |
|---|---|---|---|
| Auto mode greenfield | ~11317 | ~12626 | 14000 |
| Native mode | ~10242 | ~11551 | 13000 |
| ESM block (qwen model) | ~11315 | ~12624 | 14000 |

The phase plan suggested raising to 13000/12000. The measured actuals exceeded
those values (12626 > 13000 - 800 = 12200), so the ≥800 headroom rule took
precedence and the limits were set to 14000 and 13000 respectively. Each guard
received a `// Phase 238 added ESM cache-bust pitfall` comment.

## Tests

Four new assertions in `test/builtin-skills.test.mjs`:

- `/ESM cache-bust import does not reset module state/` — anchors the heading/opener
- `/query string is ignored for local files/` — the mechanism explanation
- `/createInventory\(\)/` — the factory pattern
- `/beforeEach/` — the call site

Test count: 1889 → 1890.
