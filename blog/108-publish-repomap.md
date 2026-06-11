# Phase 108: Publish @kodr/repomap

## What changed

The `src/repomap/` module — already cleaned up and boundary-tested in phase 95
— is now also a standalone publishable package at `packages/repomap/`.

```
packages/repomap/
  package.json        @kodr/repomap v0.1.0, MIT, type:module, no dependencies
  README.md           API docs + provenance note
  LICENSE             MIT
  src/                verbatim copies of src/repomap/*.mjs
  test/
    repomap.test.mjs  32 standalone tests, no kodr app imports
```

The main kodr app continues to import from `src/repomap/index.mjs` unchanged.

## The package

`@kodr/repomap` is dependency-free and Node 22+ builtins only. The public
API is the same as `src/repomap/index.mjs`:

- **Walk**: `listContextFiles`, `readTextPrefix`, `looksBinary`
- **Inspect**: `classifyLanguage`, `inspectFile`, `inspectWorkspace`,
  `findReferences`
- **Rank**: `rankSymbols`
- **Chunks**: `queryTokens`, `matchingSymbols`, `buildInspectionChunks`,
  `selectInspectionChunks`
- **Render**: `buildFileMap`, `renderFileMapText`, `buildFileSummaries`,
  `renderInspectionSummary`

## The test suite

The 32 standalone tests in `packages/repomap/test/repomap.test.mjs` import
only from `../src/index.mjs` — no kodr app code touches them. They cover:

- `listContextFiles`: walk, default ignores, custom ignores, patterns, sort order
- `looksBinary` / `readTextPrefix`: binary detection and prefix reads
- `classifyLanguage`: all five supported extensions
- `inspectFile`: symbol extraction, import extraction, language inference
- `inspectWorkspace`: full index build, language filter, pre-ranked query
- `findReferences`: cross-file references, empty result for unknown symbol
- `rankSymbols`: query relevance ordering, rank object shape
- `queryTokens` / `matchingSymbols`: tokenization, exact-term mode
- `buildInspectionChunks` / `selectInspectionChunks`: chunk production,
  budget selection, truncation-not-drop semantics
- `buildFileMap` / `renderFileMapText`: size entries, text rendering
- `buildFileSummaries` / `renderInspectionSummary`: compact summaries, Markdown
- Full round-trip: walk → inspect → rank → select → render

## Pre-existing boundary bug fixed

The boundary test had been failing silently because `src/post-write-sensor.mjs`
imported `classifyLanguage` directly from `./repomap/inspector.mjs` instead of
through the entry point `./repomap/index.mjs`. Phase 108 caught this when
running the boundary tests and fixed the import. The rule is simple: app code
must only reach into `src/repomap/index.mjs`; touching sibling files directly
bypasses the documented surface.

## What the provenance note says

The README includes a section explaining that this library was extracted from
kodr by running kodr against a local model — not written by a frontier model
as a one-shot deliverable. The whole point of the extraction is that the code
was produced and tested by the harness under evaluation, so the package is
a direct artifact of the kodr development loop.

## Result

- Package: `packages/repomap/` ready for `npm publish`
- Tests: 32/32 in package, 6/6 main repomap tests (boundary + surface + round-trip)
- No kodr app behavior changed
