Update the CSV expense analyzer with one small parser edge-case improvement using patch proposals only.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/csv-expenses/src/expenses.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    },
    {
      "path": "examples/csv-expenses/test/expenses.test.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ]
}

Requirements:

- Do not return a "files" array.
- Patch only:
  - examples/csv-expenses/src/expenses.mjs
  - examples/csv-expenses/test/expenses.test.mjs
- Add explicit parseCsv input validation: non-string input should throw a TypeError with a clear message.
- Add a native node:test assertion for that behavior.
- Preserve quoted commas and doubled CSV quote behavior.
- The existing tests must pass with `npm test` from examples/csv-expenses.
