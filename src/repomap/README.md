# @kodr/repomap

Zero-dependency Node.js library for workspace-level structural code analysis.
Walks a directory, extracts symbols across JavaScript, TypeScript, Python, Rust,
and Go using regex heuristics, ranks them by query relevance and reference
count, and selects byte-budgeted code chunks for context assembly.

No tree-sitter, no native bindings, no external dependencies — Node 24 builtins
only.

## Installation

This module is currently in-tree under `src/repomap/`. Import from
`src/repomap/index.mjs` or the single entry point.

## API

### Walking the workspace

```js
import { listContextFiles, readTextPrefix, looksBinary } from './index.mjs';

// Walk cwd, skip .git / node_modules / dist / build / coverage by default.
// Pass `ignore` (string[]) for exact name matches or
// `ignorePatterns` (RegExp[]) for pattern-based exclusions.
const files = await listContextFiles('/path/to/project', {
  ignore: ['vendor'],
  ignorePatterns: [/^\.cache(?:$|-)/u],
});
// => ['README.md', 'src/app.mjs', 'src/lib.py', ...]

// Read a text file prefix (returns null for binary files or read errors)
const content = await readTextPrefix('/path/to/file.mjs', 20000);

// Check whether a Buffer looks binary
const isBinary = looksBinary(Buffer.from([0, 1, 2])); // true
```

### Building the index

```js
import { classifyLanguage, inspectFile, inspectWorkspace, findReferences } from './index.mjs';

// Classify a file path by extension
classifyLanguage('src/app.mjs');   // 'javascript'
classifyLanguage('lib.rs');        // 'rust'
classifyLanguage('README.md');     // 'unknown'

// Inspect a single file (sync)
const entry = inspectFile('src/app.mjs', sourceText);
// => { path, language, lineCount, imports, symbols }
// Each symbol: { kind, name, lineStart, lineEnd }

// Build the full workspace index (async, walks + inspects all files)
const index = await inspectWorkspace('/path/to/project', {
  // Walker options (forwarded to listContextFiles)
  ignorePatterns: [/^\.kodr(?:$|-)/u],
  // Inspector options
  languages: ['javascript', 'typescript'],   // restrict languages
  symbol: 'myFunction',                      // pre-compute references
  query: 'parse input validation',           // pre-compute ranked symbols
});
// index.files     — array of inspected file entries, each with `contentLines`
// index.symbols   — flat array of all symbols with language + path
// index.languages — { javascript: 3, python: 1, ... }
// index.rankedSymbols — symbols sorted by score
// index.references    — cross-file references for `symbol` option
// index.totalFiles, index.totalSymbols
```

Each file entry in `index.files` includes a `contentLines` field:
```js
{ number: 1, text: 'export function runPrompt() {' }
```

This is a capped read (200 000 bytes max) used by ranking and chunk building.

```js
// Find cross-file references to a symbol name
const refs = findReferences(index, 'runPrompt');
// => [{ path, line, text }, ...]
```

### Ranking

```js
import { rankSymbols } from './index.mjs';

const ranked = rankSymbols(index, { query: 'parse input validation' });
// Returns symbols sorted by score. Each has a `rank` object:
// { score, queryScore, referenceCount, kindWeight }
```

Scoring: query match (100/80/60/20) + reference count × 5 (capped at 20) +
kind weight (function=5, class=4, variable=2, test=1).

### Selecting inspection chunks

```js
import { queryTokens, matchingSymbols, buildInspectionChunks, selectInspectionChunks } from './index.mjs';

// Tokenize the query (camelCase identifiers become :exact: terms)
const terms = queryTokens('parseInput validation');

// Filter ranked symbols to those matching the query
const matches = matchingSymbols(ranked, terms);

// Build code chunks for matching symbols (symbol bodies, imports, references,
// related tests)
const chunks = await buildInspectionChunks('/path/to/project', index, matches);
// Each chunk: { path, sourcePath, kind, name, lineStart, lineEnd, content }
// kind: 'symbol' | 'imports' | 'reference' | 'related-test'

// Select chunks within a character budget (truncates rather than drops the
// first chunk when budget < first chunk size)
const result = selectInspectionChunks(chunks, 40000);
// result: { chunks, usedChars, droppedChunks, droppedChars }
```

### Rendering

```js
import { buildFileMap, renderFileMapText, buildFileSummaries, renderInspectionSummary } from './index.mjs';

// Build and render a file map (includes file sizes from stat)
const fileMap = await buildFileMap('/path/to/project', files);
const text = renderFileMapText(fileMap);

// Summarise the indexed files (compact per-file view)
const summaries = buildFileSummaries(index.files);

// Render an inspection context object as a Markdown section
const markdown = renderInspectionSummary({
  mode: 'inspection-aware',
  totalFileCount: index.totalFiles,
  totalSymbolCount: index.totalSymbols,
  selectedSymbolCount: matches.length,
  rankedSymbolCount: ranked.length,
  chunks: result.chunks,
  droppedChunks: result.droppedChunks,
  droppedChars: result.droppedChars,
  fileSummaries: summaries,
  query: 'parse input validation',
});
```

## Pre-publication notes

- `renderFileMapText` includes the tool names `read_file` and `list_files`
  which are kodr-specific. These should be parameterized before publishing.
- `.kodr` is excluded by default (baked into `DEFAULT_IGNORES`).
- No index caching. Each `inspectWorkspace` call does a full walk + read.

## Supported languages

| Language   | Extensions           | Symbols extracted                        |
|------------|----------------------|------------------------------------------|
| JavaScript | .js .jsx .mjs .cjs   | function, class, arrow, variable, test   |
| TypeScript | .ts .tsx             | same as JavaScript                       |
| Python     | .py                  | class, def (test_ prefix → test kind)   |
| Rust       | .rs                  | fn, struct, enum, trait, impl, #[test]   |
| Go         | .go                  | func, type struct/interface              |
