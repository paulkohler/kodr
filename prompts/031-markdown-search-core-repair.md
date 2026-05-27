Repair the Markdown search core with patch proposals only.

Requirements:

- Use narrow search/replace patches only.
- Patch only examples/markdown-search/src/search.mjs and examples/markdown-search/src/cli.mjs.
- In searchIndex, include only documents with score greater than 0.
- In src/cli.mjs, import searchIndex from ./search.mjs.
- Do not change public export names.
- The example must pass `npm test` from examples/markdown-search.
