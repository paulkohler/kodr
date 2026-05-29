# Phase 51: Structural Code Index

## Goal

Add a zero-dependency code inspection primitive that can help Kodr select
smaller, more relevant context before asking a model to edit code.

This phase implements the simple path from the code-inspection design note: a
portable structural index, not LSP and not a full parser.

## Design

Add:

- deterministic repo scan through the existing context file inventory
- language classification for JavaScript, TypeScript, Python, Rust, and Go
- lightweight chunk extraction for top-level symbols
- imports/dependencies where they are easy to identify
- symbol index JSON
- lexical reference lookup for a named symbol
- `kodr inspect [--json]`
- `kodr inspect --symbol <name> [--json]`

The index should have a stable normalized shape so future optional external
inspectors can plug in behind it.

## Non-Goals

- No LSP client.
- No external tool registry yet.
- No semantic rename or type-aware references.
- No generated frontend.

## Done Criteria

- [x] Add `kodr inspect`.
- [x] Classify JS/TS, Python, Rust, and Go files.
- [x] Extract useful symbols/chunks for each target language.
- [x] Add lexical reference lookup.
- [x] Add tests with fixtures for each language.
- [x] Record decisions and any failures.
- [x] Blog post or update the design note with implementation details.
- [x] Mark roadmap complete and commit.
