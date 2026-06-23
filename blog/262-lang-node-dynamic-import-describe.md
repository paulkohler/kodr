# await Inside describe() Is a SyntaxError

Phase-256 ambitious dogfood. The model had to write integration tests for a
Node.js HTTP server. It reached for a dynamic import inside the test file:

```js
describe('server', () => {
  const http = await import('node:http');
  // ...
});
```

The module never ran. `node --test` reported:

```
SyntaxError: await is only valid in async functions and the top level of modules
```

The whole file failed to parse. Every test in it was skipped.

## Why it happened

`await` at the top level of an ES module is valid — that is what "top-level await"
means. But `await` inside a `describe()` callback is not top-level; it is inside a
plain (non-async) function body. The parser rejects it outright. No function runs.
No error is thrown at runtime; the module simply does not load.

The fix is trivial once you know it:

```js
import http from 'node:http'; // top of file, not inside describe()
```

Static imports are always at the module top level. Dynamic `import()` expressions
return a Promise and require `await`, so they too must live in an `async` context
— which `describe()` is not.

The model's confusion is understandable: `node:http` is a built-in, dynamic imports
feel like a fine way to get a module, and `describe()` looks like a natural place to
set things up. The combination is legal JavaScript in many other contexts. This one
is not.

## What was added

A single bullet in the preamble of `src/builtin-skills/languages/node/SKILL.md`,
immediately after the DatabaseSync anchor from Phase 261:

```
- Static imports only at module top level — `const http = await import('node:http')` inside a
  `describe()` or function body is a SyntaxError (`await` outside async). Write
  `import http from 'node:http'` at the top of the file.
```

The preamble is the right place for this. The preamble is always rendered,
never gated. The model sees it before writing any import. A pitfall buried in an
HTTP or testing section would arrive too late — the model has already made its
import decisions by then.

The technique is the same as Phase 261 (DatabaseSync) and Phase 256 (hook-async
done callback): one bullet in the preamble stops a class of parse errors cold.

## Knock-on: size guard raised

The lang:node preamble now has one more bullet (~135 chars). Two size-guard tests
in `test/system-env.test.mjs` asserted the Node/ESM system prompt stays under
13,500 chars. Both needed their ceilings raised to 13,700.

This is expected: every pitfall bullet that lands in the preamble grows the always-on
cost of the skill. The tradeoff is deliberately asymmetric — preventing a module-level
parse failure is worth 135 chars on every prompt.
