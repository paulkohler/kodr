Refresh the CSV expense analyzer wrapper/docs/sample using patch proposals only.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/csv-expenses/README.md",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    },
    {
      "path": "examples/csv-expenses/data/sample.csv",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    },
    {
      "path": "examples/csv-expenses/src/cli.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ]
}

Requirements:

- Do not return a "files" array.
- Patch only:
  - examples/csv-expenses/README.md
  - examples/csv-expenses/data/sample.csv
  - examples/csv-expenses/src/cli.mjs
- README.md must describe this as a Kodr-generated CSV expense analyzer example.
- data/sample.csv must include at least one quoted description containing a comma.
- src/cli.mjs behavior must remain compatible with the existing tests.
- The existing tests must pass with `npm test` from examples/csv-expenses.
