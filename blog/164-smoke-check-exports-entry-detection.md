# Phase 164: Smoke-Check `exports` Field Entry Detection

Modern ESM packages skip `main` and declare their entry via the `exports` field.
Before Phase 164, `detectEntryPoint` checked `scripts.start` then `main` and
stopped. A package with only an `exports` field was silently skipped.

The new priority order: `start > exports > main`. Each candidate is tried in
order; if the derived file doesn't exist on disk, the next candidate wins.

`entryFromExports` handles four `exports` shapes that appear in the wild:

```js
// String
exports: "./src/index.mjs"

// Object with "." as string
exports: { ".": "./src/index.mjs" }

// Object with "." as conditional
exports: { ".": { import: "./src/esm.mjs", require: "./src/cjs.cjs" } }

// Bare conditional (no "." subpath)
exports: { import: "./src/index.mjs", require: "./src/index.cjs" }
```

Condition resolution prefers `import` → `node` → `default`. The same safety
guards that apply to `main` and `start`-derived paths apply here: safe-relative
check (no `..` traversal, no absolute paths) and JS-extension check.

The function is a new named export from `src/smoke-check.mjs` so it can be
unit-tested in isolation — 7 targeted tests for the shapes above plus rejection
cases (non-JS extension, unsafe path, null/undefined).
