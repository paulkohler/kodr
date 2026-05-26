Apply this exact source patch for the CSV parser input validation.

Return only this JSON object shape, with one patch and no files array:

{
  "patches": [
    {
      "path": "examples/csv-expenses/src/expenses.mjs",
      "search": "EXACT_SEARCH",
      "replace": "EXACT_REPLACE"
    }
  ]
}

Use this exact search text:

```text
export function parseCsv(csv) {
	const rows = [];
```

Use this exact replace text:

```text
export function parseCsv(csv) {
	if (typeof csv !== 'string') {
		throw new TypeError('parseCsv expects a string input');
	}

	const rows = [];
```

Requirements:

- Return valid JSON only.
- Do not return markdown fences.
- Do not change the path.
- Do not add any other patch.
- The existing tests must pass with `npm test` from examples/csv-expenses.
