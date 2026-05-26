Repair the CSV expense analyzer test after the parser diagnostics improvement.

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
- Keep ESM and native node:test.
- Preserve the existing test coverage.
- The current failure is that the missing-column assertion expects /Missing required CSV column/ but the improved parser message is "Row 1 is missing required CSV column 'description'".
- Make the test accept the improved diagnostic while still checking that missing required CSV columns fail.
