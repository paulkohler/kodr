# Phase 74: Optional LSP Adapter

## Goal

Add optional Language Server Protocol integration as an external inspector path,
without making LSP a required dependency or replacing simpler CLI diagnostics.

Kodr should support JavaScript/TypeScript, Python, Rust, and Go well. LSP can
help with definitions, references, diagnostics, and symbol lookup, but it can
also be memory-heavy and brittle. The right shape is opt-in and external.

## Design

Treat LSP servers as registry-backed inspectors:

- TypeScript/JavaScript: `typescript-language-server` or project TypeScript APIs
- Python: `pyright`
- Rust: `rust-analyzer`
- Go: `gopls`

Start with one narrow operation set: document symbols, workspace symbols,
references, and diagnostics. Normalize results into the same structural index
shape used by earlier phases.

## Non-Goals

- No bundled language servers.
- No auto-installing LSP servers.
- No editor protocol or IDE integration.

## Done Criteria

- [ ] Add an opt-in LSP inspector adapter interface.
- [ ] Add fake-server tests for symbols/references/diagnostics normalization.
- [ ] Cleanly fall back when no LSP server is configured.
- [ ] Feed normalized LSP output into the ranked repo-map path.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
