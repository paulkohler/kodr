# Design Note: Code Inspection Capabilities

Kodr's next useful jump is not another way to call the model. It is better code
inspection before the model is asked to change anything.

The practical stack has layers:

- File inventory: walk the repo, classify files by path, language, size, and
  generated status.
- Structural splitting: split files into imports, exports, functions, classes,
  tests, routes, and top-level sections.
- Symbol index: record likely definitions, exports, imports, test names, and
  local references.
- Reference search: find callers and related tests for a symbol or file.
- Context expansion: given a task, include the definition chunk, callers, nearby
  tests, and directly related files.
- Patch-target inspection: before asking for edits, gather the smallest relevant
  chunks so the model does not need to rewrite full files.

This is feasible with a zero-dependency Node implementation, but only if the
first version is honest about what it is: a structural code index, not a full
semantic language engine.

## Languages

The target language set should reflect the work Kodr is meant to help with:

- JavaScript and TypeScript
- Python
- Rust
- Go

That changes the design. A JS-only brace scanner is manageable, but four
languages means the core should avoid pretending one parser model fits
everything. Each language needs a small adapter:

- classify files and tests
- find top-level symbols
- split useful chunks
- extract imports or dependencies
- find likely references

For JavaScript and TypeScript, a zero-dep scanner can get far enough by skipping
strings/comments and tracking braces around `function`, `class`, `export`, and
common test calls.

For Python, indentation-aware splitting is feasible with no dependency. The
first useful version can identify imports, classes, functions, methods, and
`pytest`/`unittest` test functions.

For Rust, a zero-dep scanner can track `mod`, `use`, `fn`, `struct`, `enum`,
`impl`, `trait`, and `#[test]`. It will not understand macros deeply, but it can
still build useful chunks.

For Go, the shape is friendlier: `package`, `import`, `func`, `type`, and
`*_test.go` conventions make a good first index realistic without dependencies.

## External Inspectors

Zero-dep should mean Kodr can run without installing a parsing stack, not that it
must ignore better tools when they are present.

A good design is a plugin-style inspector registry:

```text
core inspector
  -> built-in zero-dep language adapter
  -> optional external inspector
  -> normalized symbols/chunks/diagnostics
```

External inspectors could be system commands. Examples:

- `gopls` for Go definitions, references, and diagnostics
- `rust-analyzer` for Rust
- `pyright` or `ruff` for Python diagnostics and structure
- `typescript-language-server` or `tsserver` for JS/TS
- `tree-sitter` if installed for grammar-backed splitting

The important rule is that external tools should return normalized data to Kodr,
not leak tool-specific formats through the rest of the harness.

This same plugin shape could later apply to other capabilities, including diff
generation. Kodr can keep a built-in implementation for portability while
allowing a registered external command to provide richer output when available.

## Recommendation

Start with a zero-dep structural index.

Do not start with LSP. An LSP client is feasible with Node built-ins, but useful
LSP behavior still depends on external language servers. That should be an
optional plugin layer after the core index exists.

The first phase should prove:

- deterministic repo scan
- language classification for JS/TS, Python, Rust, and Go
- chunk extraction for each language
- symbol index JSON
- reference lookup by simple lexical search
- tests using small fixture files in each language

Once that works, Kodr can add optional external inspectors without making the
base harness heavier.

## Implementation Pass

Phase 51 implements the first version as `kodr inspect`.

The command is deliberately read-only and does not call a model. It walks the
same deterministic file inventory as context packing, classifies supported
source files, and emits a normalized index:

- files with language, imports, line count, and symbols
- flattened symbol list with paths and line spans
- optional lexical references when `--symbol <name>` is provided

The language adapters are small scanners:

- JS/TS: imports, exported functions/classes, arrow functions, variables, and
  common `test`/`it`/`describe` calls
- Python: imports plus top-level classes, functions, and `test_` functions
- Rust: `use`, `mod`, `fn`, `struct`, `enum`, `trait`, `impl`, and `#[test]`
- Go: imports, `func`, `type`, and `Test*` functions in `*_test.go`

The important design choice is the index shape, not parser completeness. Future
external inspector plugins can produce the same normalized objects with richer
data from tools like `gopls`, `rust-analyzer`, `pyright`, `tsserver`, or
Tree-sitter.

Verification covered fixture files for every target language, `kodr inspect
--symbol`, and a live repo smoke test against Kodr's own source.

## Inspection-Aware Context

Phase 52 connects the structural index to context packing with an explicit
`--inspect-context` flag.

This does not replace the existing whole-file context path. The default remains
unchanged. When the flag is present, Kodr builds the structural index before
packing context and uses the prompt text as the selection query.

The first selector is intentionally simple:

- match prompt terms against symbol names
- include matching symbol definitions
- include nearby imports
- include lexical reference windows
- include related test chunks when discoverable
- include compact file summaries as a fallback

The fallback matters. If no symbol matches the prompt, Kodr still gives the model
a summary of indexed files and symbols instead of pretending it found relevant
code.

This phase keeps the implementation portable and deterministic. It is still
lexical, not semantic, but the context is now smaller and more targeted for code
tasks that name existing functions, classes, tests, or files.

The repo smoke test found one important bug in the Phase 51 scanner:
`buildWorkspaceContext` was selected as a one-line chunk because indented
variables inside the function were also indexed as symbols. Phase 52 tightened
the JS/TS scanner to top-level lines for symbol boundaries, which made the same
smoke test select the full `buildWorkspaceContext` function span.
