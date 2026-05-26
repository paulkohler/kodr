Regenerate the CSV expense analyzer wrapper files as a clean Kodr sample.

Return only one JSON object with this shape:

{
  "files": [
    {
      "path": "examples/csv-expenses/package.json",
      "content": "..."
    },
    {
      "path": "examples/csv-expenses/README.md",
      "content": "..."
    },
    {
      "path": "examples/csv-expenses/data/sample.csv",
      "content": "..."
    },
    {
      "path": "examples/csv-expenses/src/cli.mjs",
      "content": "..."
    }
  ]
}

Requirements:

- Update only the listed files.
- Use ESM and Node.js built-ins only.
- package.json must keep a native `node --test` test script.
- src/cli.mjs must call analyzeExpenseFile from ./expenses.mjs and print the report.
- src/cli.mjs must print a concise usage error and exit with code 1 when no CSV file path is provided.
- README.md must describe this as a Kodr-generated CSV expense analyzer example.
- data/sample.csv must include date, description, category, amount rows.
- The wrapper files must pass the existing `npm test` from examples/csv-expenses.
