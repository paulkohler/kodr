Patch only the CSV parser source to add one input validation guard.

Return only one JSON object with this shape:

{
  "patches": [
    {
      "path": "examples/csv-expenses/src/expenses.mjs",
      "search": "...exact current text...",
      "replace": "...replacement text..."
    }
  ]
}

Requirements:

- Do not return a "files" array.
- Return exactly one patch.
- Patch only examples/csv-expenses/src/expenses.mjs.
- Add this guard at the start of parseCsv:
  - if csv is not a string, throw TypeError with message: parseCsv expects a string input
- Do not change any other behavior.
- The existing tests must pass with `npm test` from examples/csv-expenses.
