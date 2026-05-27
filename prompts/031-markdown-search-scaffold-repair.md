Repair the Markdown search scaffold using patch proposals only.

Requirements:

- Use narrow search/replace patches only.
- Patch only the three listed files.
- In test/search.test.mjs, import rm from node:fs/promises so t.after cleanup works.
- In src/cli.mjs, import searchFiles from ./search.mjs and remove unused imports.
- In PROVENANCE.md, correct the title to Local Markdown Search Example Provenance and record the scaffold run artifact `.kodr/runs/2026-05-26T20-59-03.521Z` as a failed verification due to missing rm import.
- The example must pass `npm test` from examples/markdown-search.
