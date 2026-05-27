Patch only the Markdown search provenance file.

Return only one JSON object with this shape:

{
  "patches": [
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
- Patch only examples/markdown-search/PROVENANCE.md.
- Correct the title to "Local Markdown Search Example Provenance".
- Record `.koder/runs/2026-05-26T20-59-03.521Z` as the scaffold run that failed verification because `rm` was not imported.
- Record `.koder/runs/2026-05-26T21-01-14.120Z` as a repair attempt that exposed a patch batching bug: earlier patches were applied before a later stale patch failed.
- Mention that the harness was updated so patch batches validate before applying.
- Keep the file concise.
- The example must pass `npm test` from examples/markdown-search.
