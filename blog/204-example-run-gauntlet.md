# Phase 204: Example Run Gauntlet

After phases 205 and 206 fixed the thinking-model context issues, it was time to
actually run the example suite. This is a record of what broke and what the fixes
were — not all of them obvious.

## What passed first try

**Rate limiter** — clean first run. The thinking model produced correct sliding-window
logic and integration tests. 5/5 pass.

**Weather API** — pure Express, no SQLite or multipart. First run, 5/5 pass. Simple
deterministic mock, nothing to go wrong.

## node:sqlite BigInt binding

Every SQLite example ran into the same wall: `stmt.run().lastInsertRowid` is a
**BigInt** in Node.js 24's `node:sqlite`. You cannot pass it directly as a SQL
parameter — `node:sqlite` rejects BigInt binds with:

```
TypeError: Provided value cannot be bound to SQLite parameter 1.
```

The fix is `Number(result.lastInsertRowid)`. Once this was in the prompt explicitly
as an example:

```js
const id = Number(result.lastInsertRowid);
return getBookmark(db, id);
```

the model followed it exactly. Without it, the model used `db.lastInsertRowid` or
`stmt.run().lastInsertRowid` directly and the POST endpoint failed.

Three bookmark-api attempts before this was discovered and encoded in the prompt.

## node:sqlite DEFAULT values

A subtler one: `DEFAULT (datetime('now'))` — which looks correct to anyone who's
written SQLite — is rejected by `node:sqlite`:

```
SqliteError: default value of column is not constant
```

SQLite only allows literal constants as column defaults. `datetime('now')` is a
function call. `CURRENT_TIMESTAMP` is a keyword constant and works fine. This was
in my own prompt, not a model mistake. The fix was correcting the prompt.

## busboy v1 is a factory function, not a class

busboy changed from class to arrow function factory in v1. The model's training data
knew the old v0 API. It used `new Busboy({...})` which throws:

```
TypeError: Busboy is not a constructor
```

Once the prompt included an explicit example with `Busboy({...})` (no `new`), the
model reproduced it correctly.

## Dynamic import inside non-async handler

The URL shortener first attempt failed `node --check`:

```
SyntaxError: Unexpected reserved word
```

The model had imported everything statically at the top but then, when writing the
`GET /links` handler, used `await import('./links.mjs')` to get `listLinks` — without
making the handler `async`. The static import was right there, it just forgot to
include `listLinks` in it.

Adding "all imports at the top of the file, no dynamic import() inside functions" to
the prompt fixed it on the next run.

## Server teardown pattern

Consistent rule across all integration tests: you need both calls in sequence:

```js
after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
});
```

`server.close()` alone leaves keep-alive connections open; `node --test` hangs for
600 seconds. The model got this right once the pattern was in the prompt, but got it
wrong (or omitted it) when it wasn't.

## The reliable pattern for qwen3.6

After all the examples:

```sh
kodr run --yes --no-heal --no-tools --no-inspect-context --no-protect-existing \
  --test "node --test" --max-turns 20 -p "..."
```

- `--no-inspect-context`: full file content, not curated chunks
- `--no-heal`: thinking model responses are large; 3 heal turns overflows 32K context
- `--no-tools`: thinking model doesn't need to read/write during reasoning
- Prompts include explicit code patterns for library quirks

The success rate went from 0/3 to 4/4 once these were in place.
