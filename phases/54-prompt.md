You are editing an existing codebase. Use ONLY the "patches" field — never "files" — for all changes. Both target files already exist.

Task: add two aggregate fields to `inspectWorkspace` in `src/code-inspector.mjs`.

Currently, near the end of `inspectWorkspace`, the function builds and returns this object:

```js
const index = {
    files: inspected,
    languages: countLanguages(inspected),
    references: [],
    symbols: inspected.flatMap((file) =>
        file.symbols.map((symbol) => ({
            ...symbol,
            language: file.language,
            path: file.path,
        })),
    ),
};
```

Add `totalFiles` and `totalSymbols` to this object:
- `totalFiles: inspected.length`
- `totalSymbols`: equal to the number of items in the `symbols` array

Use a patch on `src/code-inspector.mjs` that searches for `return index;` and replaces it so both fields are set before the return.

Also add one assertion to `test/code-inspector.test.mjs`. Find the existing `inspectWorkspace` test. It currently has these lines near the end before it returns:

```js
		assert.equal(
			index.references.map(
				(reference) => `${reference.path}:${reference.line}`,
			),
			['src/app.mjs:1', 'src/app.mjs:3', 'src/helper.py:1', 'src/helper.py:4'],
		);
	});
```

Add two assertions after those lines (still inside the `it` block) using a patch:
```js
assert.ok(typeof index.totalFiles === 'number', 'totalFiles is a number');
assert.ok(typeof index.totalSymbols === 'number', 'totalSymbols is a number');
```

Output only a JSON object with "patches" and "messages". Do not use "files".
