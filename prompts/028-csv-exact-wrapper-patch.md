Apply these exact wrapper/documentation patches for the CSV expense example.

Return only this JSON object shape, with two patches and no files array:

{
  "patches": [
    {
      "path": "examples/csv-expenses/README.md",
      "search": "EXACT_SEARCH",
      "replace": "EXACT_REPLACE"
    },
    {
      "path": "examples/csv-expenses/data/sample.csv",
      "search": "EXACT_SEARCH",
      "replace": "EXACT_REPLACE"
    }
  ]
}

README search text:

```text
A small CSV reporting tool used as a Kodr example app.
```

README replace text:

```text
A Kodr-generated CSV reporting tool used as a sample app for parser, validation, aggregation, and CLI workflows.
```

sample.csv search text:

```text
2026-05-01,Coffee,Food,4.50
```

sample.csv replace text:

```text
2026-05-01,"Coffee, beans",Food,4.50
```

Requirements:

- Return valid JSON only.
- Do not return markdown fences.
- Do not change either path.
- Do not add any other patch.
- The tests must pass with `npm test` from examples/csv-expenses.
