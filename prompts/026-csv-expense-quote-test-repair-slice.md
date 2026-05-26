Repair one failing CSV expense analyzer test.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/csv-expenses/test/expenses.test.mjs",
      "content": "..."
    }
  ]
}

Requirements:

- Update only examples/csv-expenses/test/expenses.test.mjs.
- The current failing test expects parseCsv to preserve escaped quotes.
- The CSV fixture must use CSV escaped quotes by doubling them: "Notebook ""work""".
- Keep the improved missing-column assertion.
- Preserve the rest of the tests.
