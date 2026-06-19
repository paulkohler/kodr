# Phase 210 — lang:rust Builtin Skill and Rust Workspace Detection

## Goal

Kodr tests on qwen3.6 showed the model chooses between reqwest 0.11 and 0.12
non-deterministically when the version is unspecified (2/3 bare-prompt runs
chose 0.11). The two are API-incompatible (hyper 0.14 vs hyper 1.x); mixing
them at crate boundaries causes `reqwest::Client` type conflicts. The same
approach that fixed Node pitfalls in phase 207 — encode the correct version
in the system prompt via a builtin skill — applies here.

## Changes

### `src/builtin-skills/languages/rust/SKILL.md`

New `lang:rust` skill covering:
- Cargo.toml dependency pins: reqwest `"0.12"` with `features = ["json"]`,
  serde with `features = ["derive"]`, tokio with `features = ["full"]`
- Why reqwest 0.12: 0.11 uses hyper 0.14, 0.12 uses hyper 1.x — mixing them
  causes type conflicts; `cargo tree -d` is the diagnostic
- `#[tokio::test]` for async tests (plain `#[test]` has no runtime)
- Module layout: `mod name;` in main.rs, `use super::*;` in test modules

### `src/context-packer.mjs`

- `detectRust(files, taskPrompt)` — new export; true when `Cargo.toml` present
  or prompt names a `.rs` file (greenfield signal)
- `resolveLanguageGuidance(cwd, language, options)` — generalized from
  `(cwd, isNodeEsm, options)` to dispatch on any `lang:<language>` skill name
- `packContext` — detects Rust after Node (Node takes priority); passes
  `detectedLanguage` to `resolveLanguageGuidance`; stores `isRust` in context
- `renderStableSection` — new `language` param; passes `{ guidance, language }`
  to `renderLanguageGuidanceBlock` instead of `{ guidance, isNodeEsm }`

### `src/system-env.mjs`

- `renderLanguageGuidanceBlock` — now accepts `{ language }` (new) or
  `{ isNodeEsm }` (legacy); dispatches to `getBuiltinSkill('lang:${language}')`;
  catches missing-skill errors gracefully (returns '')

### `test/system-env.test.mjs`

- Import `detectRust`
- New suites: `detectRust`, `renderLanguageGuidanceBlock — lang:rust`,
  `buildWorkspaceContext — Rust workspace`
- Budget limits updated: 6000→7000 for Node auto/toolsMode, 5000→5500 for
  native mode (limits were pre-existing stale from phase 207 skill growth)

## Done criteria

- [x] `lang:rust` SKILL.md created and built into builtin-skills.json.
- [x] `detectRust` exported from context-packer.mjs.
- [x] Rust workspace triggers `lang:rust` block in system prompt.
- [x] Node workspace is unaffected (isNodeEsm still works).
- [x] `renderLanguageGuidanceBlock` handles unknown language gracefully (returns '').
- [x] New unit tests: detectRust (4), lang:rust block (5), Rust workspace (3).
- [x] Budget assertions updated to current measured sizes.
- [x] All 69 system-env tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
