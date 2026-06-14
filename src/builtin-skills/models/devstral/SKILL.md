---
name: model:devstral
description: Devstral-specific coding contract — traps this model commonly falls into
---
# Devstral Contract
- Private class fields: declare `#field;` or `#field = value;` at the top of the class body before referencing `this.#field` in any method.
- ESM only: `import`/`export`; never `require` or `module.exports`.
- Tests: `import { test } from 'node:test'` and `node:assert` — never `t.assert()`.
