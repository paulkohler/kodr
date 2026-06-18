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
