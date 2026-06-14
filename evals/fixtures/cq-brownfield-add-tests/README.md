# cq-brownfield-add-tests

Brownfield node:test addition. Code-quality trap fixture (phase 140): the
model must write tests for an existing ESM class using Node.js built-in
`node:test` — not invented APIs like `t.assert()`, and not CommonJS.

The brownfield context (existing source, no test file to follow) is
more trap-prone than greenfield generation.
