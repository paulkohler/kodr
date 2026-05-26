Repair the current CSV expense analyzer core implementation.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/csv-expenses/src/expenses.mjs",
      "content": "..."
    }
  ]
}

Requirements:

- Update only examples/csv-expenses/src/expenses.mjs.
- Use ESM and Node.js built-ins only.
- The file must export all of these named functions:
  - analyzeExpenseFile
  - analyzeExpenseCsv
  - parseCsv
  - rowsToExpenses
  - groupByMonth
  - groupByCategory
  - renderReport
- Fix parseCsv so it returns an array of row arrays, not a flat list of fields.
- parseCsv must support quoted commas and doubled CSV escaped quotes.
- rowsToExpenses must return an array of expense objects, not an analysis object.
- Expense objects must include date, description, category, and numeric amount.
- Do not reference undefined variables such as category/date/description in returned objects.
- The existing tests must pass with `npm test` from examples/csv-expenses.
