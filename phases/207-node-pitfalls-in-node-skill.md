# Phase 207: Node.js Example Pitfalls in the Node Skill

## Goal

Encode the five recurring Node.js example pitfalls discovered across the phase
204 example runs directly in the `lang:node` builtin skill, so future Kodr runs
see them in the system prompt (the `# Node.js / ESM Contract` block) before the
model writes code — instead of rediscovering each trap at the cost of one to
three extra runs.

The five traps (each backed by a phase-204 `failures.jsonl` entry):

1. **node:sqlite BigInt bind** — `stmt.run().lastInsertRowid` is a `BigInt`;
   binding it as a SQL parameter throws `TypeError: Provided value cannot be
   bound`. Wrap with `Number()` before any SQL bind.
2. **node:sqlite DEFAULT expression** — `DEFAULT (datetime('now'))` is rejected
   as non-constant; use `DEFAULT CURRENT_TIMESTAMP`.
3. **busboy v1 factory** — busboy v1 is an arrow-function factory, not a class;
   `new Busboy({...})` throws `TypeError: Busboy is not a constructor`. Call it
   as `Busboy({ headers: req.headers })`.
4. **HTTP server teardown** — `server.close()` alone leaves keep-alive
   connections open and `node --test` hangs 600 s. Call
   `server.closeAllConnections?.()` before `server.close()`.
5. **port:0 → 0||80 coercion** — `http.request({ port: 0 })` silently becomes
   port 80. Capture the OS-assigned port with `server.address().port` inside the
   `listen` callback.

## Done criteria

- [x] `lang:node` skill (`src/builtin-skills/languages/node/SKILL.md`) carries
  all five pitfalls with code patterns (sections: "node:sqlite pitfalls
  (Node.js 24)", "HTTP integration test patterns", "busboy v1")
- [x] `src/builtin-skills.json` rebuilt from the updated skill source
- [x] `NEXT.md` candidate removed (the five separate pitfall ideas were merged
  into one shipped item)
- [x] Phase committed
