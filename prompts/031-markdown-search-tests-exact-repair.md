Apply exact small patches to the Markdown search tests.

Patch intents:

- Replace `import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';` with `import { mkdir, mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';`.
- Replace `'../../src/cli.mjs'` with `'../src/cli.mjs'`.
- Replace `'title.doc'` with `'title.md'`.
- Replace `'body.doc'` with `'body.md'`.
- Replace `'snippet.doc'` with `'snippet.md'`.
- Replace `'cli.doc'` with `'cli.md'`.
- Replace `'prompt.doc'` with `'prompt.md'`.

Requirements:

- Use narrow search/replace patches only.
- The example must pass `npm test` from examples/markdown-search.
