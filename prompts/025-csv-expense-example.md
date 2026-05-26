Create a small example app under examples/csv-expenses.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/csv-expenses/package.json",
      "content": "..."
    }
  ]
}

Requirements:

- Use ESM.
- Do not use CommonJS globals such as require, module, or __dirname.
- Use Node.js built-ins only for this example.
- The example app may have its own package.json.
- Provide a CLI at src/cli.mjs.
- Provide reusable CSV/report logic at src/expenses.mjs.
- Read a CSV with columns: date, description, category, amount.
- Correctly parse quoted fields, commas inside quoted fields, and escaped quotes.
- Validate dates as YYYY-MM-DD and amounts as numbers.
- Group totals by month and category.
- Print a readable text report from the CLI.
- Add sample data under data/sample.csv.
- Add native node:test coverage under test/.
- Add a README.md with usage examples.
- Keep the implementation small and readable.
