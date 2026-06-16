# Phase 164: Smoke-Check `exports` Field Entry Detection

## Motivation

`detectEntryPoint` previously only checked `scripts.start` (as `node <file>`)
and `main`. Modern ESM packages use the `exports` field instead of (or in
addition to) `main`. A package without a `scripts.start` or a `main` field — but
with an `exports` field pointing to the entry — would silently skip the
smoke-check, even when a valid entry exists.

## What this phase does

**`src/smoke-check.mjs`** — new exported function `entryFromExports(exportsField)`:
- Handles four forms:
  - String: `"./src/index.mjs"` → `"src/index.mjs"`
  - Object with `"."` as string: `{ ".": "./src/index.mjs" }` → `"src/index.mjs"`
  - Object with `"."` as conditional: `{ ".": { import: "./src/esm.mjs" } }` → prefers `import > node > default`
  - Bare conditional (no `"."` subpath): `{ import: "./src/index.mjs" }` → prefers `import > node > default`
- Applies the same safety checks as other entry detection paths: safe-relative,
  JS file extension.

**`detectEntryPoint` updated**: priority order `start > exports > main`. If the
`exports`-derived file doesn't exist on disk, falls through to `main`.

**`test/smoke-check.test.mjs`**: 10 new tests — 7 for `entryFromExports`
(string, dot-string, conditional, bare-conditional, non-JS, unsafe paths,
null/undefined) and 3 for `detectEntryPoint` with exports (uses exports, start
wins over exports, falls back to main on missing file).

## Done criteria

- [x] `entryFromExports` exported and tested (7 cases).
- [x] `detectEntryPoint` uses exports as middle priority (3 integration tests).
- [x] Suite 1566 green; format + check clean.
- [x] Decisions logged; roadmap checked; version bump; committed.
