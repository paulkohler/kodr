# Phase 95: Extractable Repo Map Library

## What changed

The structural code index, ranked repo-map, and inspection chunk selection are
now a self-contained module under `src/repomap/`. `src/code-inspector.mjs` and
`src/repo-map.mjs` are gone; all import sites now go through
`src/repomap/index.mjs`.

The new layout:

```
src/repomap/
  index.mjs          ← single public entry point
  workspace-files.mjs ← walk, readTextPrefix, looksBinary
  inspector.mjs      ← classifyLanguage, inspectFile, inspectWorkspace, findReferences
  rank.mjs           ← rankSymbols
  chunks.mjs         ← buildInspectionChunks, selectInspectionChunks, matchingSymbols, queryTokens
  render.mjs         ← buildFileMap, renderFileMapText, buildFileSummaries, renderInspectionSummary
  README.md          ← future package README with runnable examples
```

## The hidden contract that needed fixing

The biggest coupling problem wasn't the import direction — it was
`_contentLines`. The inspector attached it to each file entry as a
non-enumerable property:

```js
Object.defineProperty(inspectedFile, '_contentLines', {
  value: content.split(/\r?\n/u).map((text, index) => ({ number: index + 1, text })),
});
```

The ranker and chunk builder silently consumed `file._contentLines`. The
external inspector registry preserved it with:

```js
return { ...baseFile, ...externalFile, _contentLines: baseFile._contentLines };
```

None of this was documented. A published library cannot ship secret handshakes;
once the field is non-enumerable and undocumented, every consumer has to read
the source to understand the contract. Phase 95 renamed it to `contentLines` — a
plain, enumerable, documented field — and updated every touch point.

## The dependency inversion

Before: `code-inspector.mjs` → imported `listContextFiles` from
`context-packer.mjs`.

"Inspect a repo" dragged in prompt assembling, base contract rendering, and
skill loading. The fix is simple: `workspace-files.mjs` owns the walk; the
inspector imports from the library, not the app.

## The `.kodr` ignore pattern

The old `shouldIgnoreEntry` tested `/^\.kodr(?:$|-)/u` unconditionally. The
library has no business knowing about kodr artifact directories. The default
ignores are now `.git`, `node_modules`, `dist`, `build`, `coverage`. Kodr
passes its own pattern via `options.ignorePatterns`:

```js
// context-packer.mjs
const KODR_IGNORE_PATTERNS = [/^\.kodr(?:$|-)/u];

export async function listContextFiles(cwd) {
  return repomapListContextFiles(cwd, { ignorePatterns: KODR_IGNORE_PATTERNS });
}
```

## Three new tests

**Boundary test** (`test/repomap-boundary.test.mjs`): statically reads every
`.mjs` file in `src/repomap/` and asserts all `from` specifiers are either
`node:*` builtins or `./sibling` files with no path separators. A second
assertion scans `src/` app files and confirms nothing imports
`repomap/internal-file` — only `repomap/index.mjs`. This test catches accidental
coupling before it reaches the module boundary.

**Surface test** (`test/repomap-surface.test.mjs`): imports
`src/repomap/index.mjs` as `* as repomap` and diffs the actual export names
against a hardcoded expected set. Extra or missing exports are failures. Guards
against accidental surface growth before publication.

**Round-trip test** (`test/repomap-round-trip.test.mjs`): uses only the public
entry point — no app imports — to walk a fixture workspace, build the index,
rank against a query, select chunks within a small budget, and assert the
`contentLines` field is present on each file entry.

## Result

596 tests, all pass. The boundary test confirms the module could be copied out
of `src/` and published as a standalone package without touching kodr's app,
completion, or session code.
