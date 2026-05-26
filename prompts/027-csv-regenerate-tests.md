Regenerate the CSV expense analyzer tests as a clean Kodr sample.

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
- Use ESM and native node:test.
- Use Node.js built-ins only.
- Test parseCsv with quoted commas and doubled CSV escaped quotes. The fixture must contain: "Notebook ""work"""
- Test missing required columns, invalid dates, and invalid amounts.
- Test grouping by month and category.
- Test renderReport output.
- Test the CLI by writing a temporary CSV file and running node src/cli.mjs from examples/csv-expenses.
- The tests must pass with `npm test` from examples/csv-expenses.
