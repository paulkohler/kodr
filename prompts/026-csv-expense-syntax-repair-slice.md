Repair one syntax error in the CSV expense analyzer test file.

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
- Fix the malformed assert.deepEqual call in the quoted fields test.
- Preserve the CSV fixture that uses doubled CSV quotes: "Notebook ""work""".
- Preserve the improved missing-column assertion.
- Preserve every other test behavior.
- The file must pass `node --check examples/csv-expenses/test/expenses.test.mjs`.
