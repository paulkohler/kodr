# Phase 108: Publish @kodr/repomap

## Summary

Extract the `src/repomap/` module into a standalone publishable package at
`packages/repomap/`. The package is `@kodr/repomap` — a zero-dependency,
Node.js-builtins-only, ESM library for workspace-level structural code
analysis. The in-tree `src/repomap/` copy is kept and remains the import
source for the main kodr app.

## What was done

- Created `packages/repomap/` with the standard publishable layout:
  - `package.json` — `@kodr/repomap` v0.1.0, MIT, ESM, no dependencies
  - `src/` — verbatim copies of all six `src/repomap/*.mjs` files
  - `LICENSE` — MIT, copied from repo root
  - `README.md` — adapted from `src/repomap/README.md` with updated install
    instructions and a provenance section
  - `test/repomap.test.mjs` — 32 standalone tests covering every public API
    export, using only `../src/index.mjs` (no kodr app imports)

- Fixed a pre-existing boundary violation: `src/post-write-sensor.mjs`
  imported `classifyLanguage` directly from `./repomap/inspector.mjs` instead
  of the entry point `./repomap/index.mjs`. Corrected to go through the public
  API. This was caught by the existing boundary test which was already failing
  before this phase.

## Sync note

The files in `packages/repomap/src/` are copies of `src/repomap/`. When
`src/repomap/` changes, `packages/repomap/src/` must be updated in the same
commit. The phase 108 test suite (`packages/repomap/test/repomap.test.mjs`)
serves as the publication smoke test — run it before bumping the package
version.

## Done Criteria

- [x] `packages/repomap/` created with package.json, README, LICENSE, src/,
      test/
- [x] `package.json` — name `@kodr/repomap`, version `0.1.0`, type module,
      exports `{ ".": "./src/index.mjs" }`, no dependencies, engines node>=22
- [x] Source files copied verbatim from `src/repomap/`
- [x] README includes provenance section and updated install instructions
- [x] Standalone test suite: 32 tests covering all public API exports
- [x] Package tests pass: `node --test test/repomap.test.mjs` → 32/32
- [x] Main kodr repomap tests still pass (boundary, surface, round-trip)
- [x] Pre-existing boundary violation in `post-write-sensor.mjs` fixed
- [x] `process/decisions.jsonl` updated
- [x] Blog post written
- [x] Roadmap marked complete
- [x] Commit
