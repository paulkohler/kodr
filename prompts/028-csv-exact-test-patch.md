Apply this exact test patch for the CSV parser input validation.

Return only this JSON object shape, with one patch and no files array:

{
  "patches": [
    {
      "path": "examples/csv-expenses/test/expenses.test.mjs",
      "search": "EXACT_SEARCH",
      "replace": "EXACT_REPLACE"
    }
  ]
}

Use this exact search text:

```text
	assert.equal(rows[2][1], 'Notebook "work"');
	});

	it('validates required columns and fields', () => {
```

Use this exact replace text:

```text
	assert.equal(rows[2][1], 'Notebook "work"');
	});

	it('rejects non-string CSV input', () => {
		assert.throws(
			() => parseCsv(123),
			(error) =>
				error instanceof TypeError &&
				error.message === 'parseCsv expects a string input',
		);
	});

	it('validates required columns and fields', () => {
```

Requirements:

- Return valid JSON only.
- Do not return markdown fences.
- Do not change the path.
- Do not add any other patch.
- The tests must pass with `npm test` from examples/csv-expenses.
