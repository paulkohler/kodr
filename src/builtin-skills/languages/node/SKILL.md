---
name: lang:node
description: Node.js / ESM coding contract — the mechanical rules local models most often break
---
# Node.js / ESM Contract
- ESM only: use `import`/`export`; never `require` or `module.exports`; no top-level `return` outside a function.
- Tests: `import { test } from 'node:test'` and `node:assert` — do not invent methods like `t.assert()`.
- CLI argv: `process.argv` entries are separate tokens (`--top` and `3` are two entries); parse flags with a token loop, not a single-string regex.
