# Phase 53: External Inspector Registry

## Goal

Create a zero-dependency registry for optional external code-inspection tools.

Kodr should keep its built-in structural index as the portable baseline while
allowing installed tools to enrich the same normalized inspection shape.

## Design

Add a small registry that can describe external inspector commands:

- name
- languages
- executable command
- availability check
- normalized output adapter
- timeout and failure behavior

The first implementation should focus on registry shape and fake-command tests,
not full integrations with language servers.

## Candidate Tools

- `gopls` for Go
- `rust-analyzer` for Rust
- `pyright` or `ruff` for Python
- `tsserver` or `typescript-language-server` for JS/TS
- `tree-sitter` when installed

## Non-Goals

- No required external dependencies.
- No bundled language servers.
- No full LSP client yet.
- No external diff implementation yet.

## Done Criteria

- [ ] Add an external inspector registry module.
- [ ] Add command discovery and timeout handling.
- [ ] Normalize external results into the structural index shape.
- [ ] Fall back cleanly to the built-in inspector.
- [ ] Add tests with fake external commands.
- [ ] Record decisions and any failures.
- [ ] Blog post or update the inspection design note.
- [ ] Mark roadmap complete and commit.
