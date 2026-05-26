Improve the existing CSV expense analyzer parser in examples/csv-expenses.

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
- Keep ESM and Node.js built-ins only.
- Keep the public exports compatible with the current tests.
- Preserve quoted-field parsing, escaped quote parsing, validation, grouping, and text report behavior.
- Make a small real improvement to parser diagnostics or validation clarity.
