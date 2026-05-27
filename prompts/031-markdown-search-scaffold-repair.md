Repair the Markdown search scaffold using patch proposals only.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    },
    {
      "path": "examples/markdown-search/src/cli.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    },
    {
      "path": "examples/markdown-search/PROVENANCE.md",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ],
  "scratchpad": "..."
}

Requirements:

- Do not return a "files" array.
- Patch only the three listed files.
- In test/search.test.mjs, import rm from node:fs/promises so t.after cleanup works.
- In src/cli.mjs, import searchFiles from ./search.mjs and remove unused imports.
- In PROVENANCE.md, correct the title to Local Markdown Search Example Provenance and record the scaffold run artifact `.koder/runs/2026-05-26T20-59-03.521Z` as a failed verification due to missing rm import.
- The example must pass `npm test` from examples/markdown-search.
