Repair the Markdown search tests using patch proposals only.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ],
  "scratchpad": "..."
}

Requirements:

- Do not return a "files" array.
- Patch only examples/markdown-search/test/search.test.mjs.
- Import mkdir from node:fs/promises.
- Use .md file extensions in all indexed fixture files, not .doc.
- Fix the CLI path to point to examples/markdown-search/src/cli.mjs from the test file.
- Keep coverage for indexing, ranking, snippets, CLI output, and prompt-injection-like text as searchable data.
- The example must pass `npm test` from examples/markdown-search.
