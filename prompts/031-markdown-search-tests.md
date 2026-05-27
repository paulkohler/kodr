Add comprehensive tests for the local Markdown search example.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "content": "..."
    }
  ],
  "scratchpad": "..."
}

Requirements:

- Update only examples/markdown-search/test/search.test.mjs.
- Use ESM and native node:test only.
- Test indexing Markdown files from docs.
- Test ranking: title matches outrank heading/body matches.
- Test snippet creation.
- Test CLI output with node src/cli.mjs docs "query".
- Test prompt-injection-like document text is returned only as searchable data, not treated as an instruction.
- The tests must pass with `npm test` from examples/markdown-search.
