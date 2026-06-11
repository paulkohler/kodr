# Phase 95: Extractable Repo Map Library

## Summary

Refactor the structural code index (phase 51), ranked repo-map (phase 59),
and inspection/file-map context selection (phases 52, 61) into one
self-contained module under `src/repomap/` with a single public entry point.
The boundary must be clean enough that the directory could be lifted out as
a standalone `@kodr/repomap` npm package without touching kodr's app,
completion, or session code. This phase reorganizes; it does not publish.

## Motivation

- Extractability is the proof of the architecture. The index, ranking, and
  chunk selection are supposed to be pure workspace analysis, but today the
  dependency arrow points the wrong way: `code-inspector.mjs` imports its
  file walk from `context-packer.mjs`, which is also the prompt assembler
  (Kodr base contract, skills, memory, prompt-section hashing). "Inspect a
  repo" currently drags in prompt rendering. Drawing the boundary now —
  before phase 96 config and phase 97 defaults add more call sites — is
  cheaper than refactoring later.
- The competitive landscape has a gap. Aider's repo map is the reference
  implementation for ranked structural context, but it is Python, and it
  (like the JS ports that exist) depends on tree-sitter grammars via native
  or wasm bindings. There is no zero-dependency Node library that walks a
  workspace, extracts symbols across JS/TS/Python/Rust/Go, ranks them by
  references and query relevance, and selects byte-budgeted chunks. Kodr's
  Node-builtins-only implementation fits that niche exactly — but only if
  it stands alone.
- The internals already show hidden-coupling debt: `_contentLines` is an
  undocumented non-enumerable property that the inspector attaches and the
  packer and ranker quietly consume. A published library cannot ship a
  secret handshake; making the contract explicit also makes it testable.

## Design

New module layout, all under `src/repomap/`:

- `index.mjs` — the only file the rest of kodr (or a future package
  consumer) may import. Exports the public API and nothing else.
- `workspace-files.mjs` — recursive walk, ignore rules, symlink skip,
  binary sniffing, capped prefix reads (today `listContextFiles`, `walk`,
  `readTextPrefix`, `looksBinary` in `context-packer.mjs`).
- `inspector.mjs` — `classifyLanguage`, `inspectFile`, `inspectWorkspace`,
  `findReferences` (today `code-inspector.mjs`).
- `rank.mjs` — `rankSymbols` (today `repo-map.mjs`).
- `chunks.mjs` — inspection chunk building and byte-budget selection
  (today `buildInspectionChunks`, `selectInspectionChunks`, and their
  helpers in `context-packer.mjs`).
- `render.mjs` — plain-text renderers with no kodr voice: the file-map
  listing and the inspection summary markdown.
- `README.md` — the public API documented with examples, written as the
  future package README.

API decisions:

- Ignore rules become an option (`{ ignore: [...] }`) on top of generic
  defaults (`.git`, `node_modules`, `dist`, `build`, `coverage`). The
  `.kodr` artifact-dir pattern is passed in by kodr, not baked into the
  library.
- `_contentLines` stops being a hidden `Object.defineProperty` contract.
  The index carries file content lines as a documented field (content is
  already size-capped by `MAX_INSPECT_BYTES`), so any consumer can rank and
  build chunks from an index it holds.
- `inspectWorkspace` accepts pre-inspected file entries, so the external
  inspector registry (phase 53) feeds normalized results through the public
  API instead of reaching into index assembly.
- Chunk selection takes an explicit `budgetChars`. Kodr's token-budget
  planning (`planContextBudget`, phase 61) stays app-side and computes that
  number; the library never sees model options.

What changes in kodr:

- `src/code-inspector.mjs` and `src/repo-map.mjs` are removed. Import sites
  (`tool-calls.mjs`, `app.mjs`, `context-packer.mjs`,
  `external-inspector-registry.mjs`, `skills.mjs`, `tools.mjs`,
  `orchestration.mjs`, and tests) switch to `src/repomap/index.mjs`.
- `context-packer.mjs` shrinks to the app concerns: prompt sections, base
  contract, AGENTS.md/memory/skills rendering, budget planning, and the
  lockfile map-only policy — consuming the library for walking, inspection
  context, and file maps.

What does not change:

- Symbol extraction regexes, ranking weights and tie-breaks, chunk
  selection heuristics, and inspection limits move verbatim — no behavior
  tuning rides along with the refactor.
- CLI flags, tool schemas (`inspect_symbols`, `find_references`,
  `list_files`, `read_file`), prompt text, and artifact formats.
- `external-inspector-registry.mjs` (process spawning) and
  `inspection-output.mjs` (CLI rendering voice) stay app-side.
- No new dependencies: Node 24 builtins only, ESM throughout.

## Test Requirements

- Existing `code-inspector`, `repo-map`, and inspection-path
  `context-packer` tests keep passing with import-path updates only — they
  are the behavior lock for the move.
- New boundary test: statically scan `src/repomap/` and assert every import
  is a `node:` builtin or a sibling repomap file; scan the rest of `src/`
  and assert nothing imports repomap internals — only the entry point.
- New entry-point surface test: the exports of `index.mjs` are exactly the
  documented API, guarding accidental surface growth before publication.
- New round-trip test using only the public entry point: walk a fixture
  workspace, build the index, rank against a query, and select chunks
  within a small budget — with no kodr app modules imported.

## Non-Goals

- No npm publish, no separate `package.json`, no workspaces split. The
  module stays in-tree; publishing is a later phase if it earns one.
- No tree-sitter or any parser dependency; regex extraction stays.
- No index caching or incremental re-indexing.
- No new languages, ranking signals, or chunk heuristics.
- No change to phase 75's LSP adapter plan (an adapter would feed this
  library's index from outside it).

## Done Criteria

- [x] `src/repomap/` exists with `index.mjs` as the single entry point and
      the layout above.
- [x] Boundary test proves repomap imports only node builtins plus sibling
      repomap files, and app code imports only the entry point.
- [x] `src/code-inspector.mjs` and `src/repo-map.mjs` removed; all import
      sites updated.
- [x] `.kodr` ignore pattern injected by kodr via options, not hardcoded in
      the library.
- [x] `_contentLines` replaced by a documented index field.
- [x] External inspector registry assembles its index through the public
      API.
- [x] `src/repomap/README.md` documents the API with runnable examples.
- [x] Full test suite passes with only import-path edits to existing
      tests; new repomap tests added per Test Requirements.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
