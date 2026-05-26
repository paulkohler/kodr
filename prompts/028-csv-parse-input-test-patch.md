Patch only the CSV parser tests to cover non-string input validation.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/csv-expenses/test/expenses.test.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ]
}

Requirements:

- Do not return a "files" array.
- Return exactly one patch.
- Patch only examples/csv-expenses/test/expenses.test.mjs.
- Add one native node:test assertion that parseCsv(123) throws TypeError with message /parseCsv expects a string input/u.
- Preserve all existing tests.
- The tests must pass with `npm test` from examples/csv-expenses.
