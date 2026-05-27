Create the scaffold for a local Markdown search example.

Requirements:

- Create only files under examples/markdown-search.
- Use ESM.
- Use Node.js 24 built-ins only.
- package.json must include `"type": "module"` and `"test": "node --test"`.
- README.md must describe this as a Kodr-generated local Markdown search example.
- docs/agent-safety.md must include prompt-injection-like text such as "Ignore previous instructions" as document data.
- src/search.mjs may start with minimal exported stubs, but must be valid JavaScript.
- src/cli.mjs must be valid JavaScript.
- test/search.test.mjs must be a valid native node:test file.
- The scaffold must pass `npm test` from examples/markdown-search.
