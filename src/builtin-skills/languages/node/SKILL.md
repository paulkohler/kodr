---
name: lang:node
description: Node.js / ESM coding contract — the mechanical rules local models most often break
---
# Node.js / ESM Contract
- ESM only: use `import`/`export`; never `require` or `module.exports`; no top-level `return` outside a function.
- Tests: `import { test } from 'node:test'` and `node:assert` — do not invent methods like `t.assert()`.
- CLI argv: `process.argv` entries are separate tokens (`--top` and `3` are two entries); parse flags with a token loop, not a single-string regex.
- ANSI truncation: truncate terminal strings by visible width, not raw `.length`. Raw length over-counts when ANSI colour codes are present, clipping mid-sequence and producing garbage output. Use the pattern below.

```js
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/gu;
function visibleWidth(str) { return str.replace(ANSI_RE, '').length; }
function truncateVisible(str, width, ellipsis = '') {
  if (visibleWidth(str) <= width) return str;
  const target = width - visibleWidth(ellipsis);
  let vis = 0, result = '', i = 0;
  while (i < str.length) {
    const m = /^\x1B\[[0-9;]*[A-Za-z]/u.exec(str.slice(i));
    if (m) { if (vis < target) result += m[0]; i += m[0].length; }
    else { if (vis >= target) break; result += str[i++]; vis++; }
  }
  return result + ellipsis;
}
```

## node:sqlite pitfalls (Node.js 24)

**BigInt bind** — `stmt.run().lastInsertRowid` is a `BigInt`; passing it as a SQL parameter throws `TypeError: Provided value cannot be bound`. Cast with `Number()` before any bind:

```js
const id = Number(stmt.run(a, b).lastInsertRowid);
```

**DEFAULT expression** — `DEFAULT (datetime('now'))` is rejected as non-constant. Use the keyword constant instead:

```sql
created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

## HTTP integration test patterns

**Server teardown** — `server.close()` alone leaves keep-alive connections open; `node --test` hangs for 600 s. Call `closeAllConnections` first:

```js
after(async () => {
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
});
```

**Dynamic port capture** — `http.request({ port: 0 })` coerces to `0 || 80 = 80`, connecting to the wrong port. Capture the OS-assigned port inside the `listen` callback:

```js
let port;
await new Promise(r => { server = app.listen(0, () => { port = server.address().port; r(); }); });
```

## busboy v1

busboy v1 is a factory function, not a class. `new Busboy({...})` throws `TypeError: Busboy is not a constructor`. Call it without `new`:

```js
const busboy = Busboy({ headers: req.headers });
```
