Apply exact small patches to the Markdown search tests.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';",
      "replace": "import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "'../../src/cli.mjs'",
      "replace": "'../src/cli.mjs'"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "'title.doc'",
      "replace": "'title.md'"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "'body.doc'",
      "replace": "'body.md'"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "'snippet.doc'",
      "replace": "'snippet.md'"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "'cli.doc'",
      "replace": "'cli.md'"
    },
    {
      "path": "examples/markdown-search/test/search.test.mjs",
      "search": "'prompt.doc'",
      "replace": "'prompt.md'"
    }
  ],
  "scratchpad": "Repair test imports, CLI path, and Markdown file extensions with exact current string anchors."
}

Requirements:

- Return valid JSON only.
- Do not add markdown fences.
- Do not add a files array.
- The example must pass `npm test` from examples/markdown-search.
