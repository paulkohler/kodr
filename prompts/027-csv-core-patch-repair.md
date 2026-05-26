Repair examples/csv-expenses/src/expenses.mjs using patch proposals only.

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
- Patch only examples/csv-expenses/src/expenses.mjs.
- Use one or more exact search/replace patches.
- Export parseCsv.
- parseCsv must return an array of row arrays.
- rowsToExpenses must return an array of expense objects.
- analyzeExpenseCsv must call rowsToExpenses, then groupByMonth and groupByCategory.
- Fix any undefined variables in expense object construction.
- Keep ESM and Node.js built-ins only.
- The existing tests must pass with `npm test` from examples/csv-expenses.
