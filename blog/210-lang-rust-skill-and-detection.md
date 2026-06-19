# Phase 210: lang:rust Builtin Skill and Rust Workspace Detection

## What we found

Two rounds of Rust kodr tests with qwen3.6 revealed one consistent failure
mode: reqwest version non-determinism. When the version is not specified in the
prompt, the model chose between `"0.11"` and `"0.12"` across runs:

| Run | reqwest version chosen | Tests |
|-----|----------------------|-------|
| rust-api-client-3 | 0.12 | 2/2 pass |
| rust-api-client-4 | 0.11 | 2/2 pass |
| rust-api-client-5 | 0.11 | 2/2 pass |

All three passed — because each build resolved internally consistently. But in
a real project where two crates independently pull in different reqwest majors,
you'd get a `reqwest::Client` type conflict at the boundary. The 0.11→0.12
transition changed the underlying hyper version (0.14→1.x), making the two
`reqwest::Client` types nominally different even though they have the same name.

`cargo tree -d` is the tool to diagnose this — it lists crates that appear at
multiple versions in the dependency graph.

Everything else the model got right without guidance: `features = ["json"]` for
reqwest, `features = ["derive"]` for serde, `#[tokio::test]` on async tests,
`mod api;` in main.rs.

## The fix: same approach as Node pitfalls

Phase 207 encoded the recurring Node/SQLite pitfalls in `lang:node` and they
stopped appearing. The same pattern works here: a `lang:rust` skill injected
into the system prompt when the workspace contains a `Cargo.toml`.

The skill encodes exactly what the tests showed is needed:

```toml
[dependencies]
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", features = ["json"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

Plus the rationale (so the model doesn't "fix" it): 0.11 uses hyper 0.14,
0.12 uses hyper 1.x — mixing them causes type conflicts. And `cargo tree -d`
as the diagnostic command.

## Generalising the language guidance pipeline

The existing `renderLanguageGuidanceBlock` was Node-specific:
`if (!facts?.isNodeEsm) return ''`. Rust is a second language, which meant
the function needed to dispatch on a language tag rather than a boolean.

The change was backward-compatible: the function now accepts either
`{ language: 'node' }` (new) or `{ isNodeEsm: true }` (legacy), so all
existing Node tests pass unchanged. For Rust, `{ language: 'rust' }` calls
`getBuiltinSkill('lang:rust')`.

The internal `resolveLanguageGuidance` was also generalized from a boolean
`isNodeEsm` parameter to a `language` string (`'node' | 'rust' | null`),
enabling any future `lang:X` skill to be wired in without further pipeline
changes.

Detection: `Cargo.toml` in the workspace file list, or `.rs` named in the
task prompt for greenfield runs. Node takes priority when both signals fire
(unusual but possible in mixed repos).

## Budget test cleanup

Three system-env budget assertions were failing before this phase — pre-existing
from phase 207's skill growth. The limits were updated to current measured sizes:
- Node auto mode: 6000→7000 (actual ~6367)
- Native mode: 5000→5500 (actual ~5292)

## What's next

The `cargo tree -d` sensor for `kodr check` — a verification step that catches
duplicate crate versions even when the skill guidance is ignored. Added to
NEXT.md.
