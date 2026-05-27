Repair the Markdown search example with exact, small patches.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/markdown-search/src/search.mjs",
      "search": "exact current text",
      "replace": "replacement text"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "exact current text",
      "replace": "replacement text"
    }
  ],
  "scratchpad": "brief note"
}

Requirements:

- Return valid JSON only.
- Do not add markdown fences.
- Do not add a files array.
- Keep Node.js built-ins only.
- Export a `createSnippet(doc, terms)` helper from `examples/markdown-search/src/search.mjs`.
- Use `createSnippet` from `searchIndex` instead of inline snippet construction.
- Update `examples/markdown-search/test/search.test.mjs` to import and test `createSnippet`.
- Fix only incorrect test score fixtures/comments:
  - In `indexing markdown files from docs`, either make the first document title contain `search` or change the assertion/comment so it matches the current behavior. Prefer making the fixture test title weighting.
  - In `ranking: title outranks heading and body`, the score should match the implementation's actual weights: title fallback plus heading plus body when the same first heading is also the title.
- Strengthen the prompt-injection-like test content so it includes instruction-like Markdown text such as "Ignore previous instructions", but assert it is treated only as searchable data.
- The example must pass `npm test` from `examples/markdown-search`.
