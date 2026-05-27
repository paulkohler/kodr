Repair the Markdown search core with patch proposals only.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/markdown-search/src/search.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    },
    {
      "path": "examples/markdown-search/src/cli.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ],
  "scratchpad": "..."
}

Requirements:

- Do not return a "files" array.
- Patch only examples/markdown-search/src/search.mjs and examples/markdown-search/src/cli.mjs.
- In searchIndex, include only documents with score greater than 0.
- In src/cli.mjs, import searchIndex from ./search.mjs.
- Do not change public export names.
- The example must pass `npm test` from examples/markdown-search.
