# Phase 207: Node.js Example Pitfalls in the Node Skill

## The problem

Phase 204 ran four rounds of HTTP/SQLite example generations against the local
model. The same five mistakes kept surfacing, each costing one to three extra
runs to diagnose and repair:

- `getBookmark` threw `TypeError: Provided value cannot be bound to SQLite
  parameter 1` — `lastInsertRowid` is a `BigInt`, and node:sqlite refuses to
  bind it (`204-bookmark-api-3`).
- `CREATE TABLE ... DEFAULT (datetime('now'))` was rejected with "default value
  of column is not constant" (`204-bookmark-api-2`).
- `new Busboy({...})` threw `Busboy is not a constructor` — busboy v1 is a
  factory function, not a class (`204-file-upload-2`).
- HTTP integration tests hung for the full 600 s test timeout because
  `server.close()` left keep-alive connections open (`204-file-upload`).
- Every test hit `ECONNREFUSED 127.0.0.1:80` because `http.request({ port: 0 })`
  coerces to `0 || 80 = 80` (`204-bookmark-api`).

## Why guidance, not a sensor

These are not extraction or harness bugs — the model writes syntactically valid
code that fails at runtime. Two of them (busboy class, `datetime('now')`) are
stale-API habits; three are subtle JavaScript coercion or lifecycle traps
(`BigInt` bind, `0 || 80`, keep-alive teardown). `node --check` cannot catch any
of them. The cheapest place to prevent a class of model mistake is the system
prompt, before the model writes the line.

The `lang:node` builtin skill body is already injected as the `# Node.js / ESM
Contract` block for any Node/ESM workspace (phase 122). So the fix is to encode
each trap there with the exact correct code pattern.

## The fix

Three new sections in `src/builtin-skills/languages/node/SKILL.md`:

- **node:sqlite pitfalls (Node.js 24)** — `Number(stmt.run(...).lastInsertRowid)`
  before any bind; `DEFAULT CURRENT_TIMESTAMP` not `DEFAULT (datetime('now'))`.
- **HTTP integration test patterns** — `server.closeAllConnections?.()` in an
  `after` hook before `server.close()`; capture `server.address().port` inside
  the `listen` callback.
- **busboy v1** — `Busboy({ headers: req.headers })`, no `new`.

`src/builtin-skills.json` is rebuilt from the updated source.

## Lesson

Recurring runtime traps that survive `node --check` belong in the language
skill, where they are injected into the prompt and prevented up front — not
left to be rediscovered one example at a time. Stale-API and JS-coercion
mistakes are exactly this shape: the model has to be told the current correct
pattern before it writes the wrong one.
