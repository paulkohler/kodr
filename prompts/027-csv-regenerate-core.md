Regenerate the CSV expense analyzer core implementation as a clean Kodr sample.

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
- Export these functions:
  - analyzeExpenseFile(path)
  - analyzeExpenseCsv(csv)
  - parseCsv(csv)
  - rowsToExpenses(rows)
  - groupByMonth(expenses)
  - groupByCategory(expenses)
  - renderReport(analysis)
- parseCsv must support commas inside quoted fields and escaped double quotes using standard doubled CSV quotes.
- rowsToExpenses must require date, description, category, and amount columns.
- Validate dates as YYYY-MM-DD, non-empty description/category, and finite numeric amounts.
- Group totals by month and category with deterministic key ordering.
- renderReport must include total, by-month totals, and by-category totals.
- Keep output compatible with the existing tests.
