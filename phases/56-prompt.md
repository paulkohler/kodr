You are editing an existing codebase. Use ONLY "patches" — never "files" — for all changes. All four target locations are in existing files.

## Task

Add a `--languages` flag to `kodr inspect` that filters the index to the named languages only.

---

## Patch 1 — add languages default in options init (src/app.mjs)

Search for exactly (this appears in the options initialisation block):

```
		inspectSymbol: '',
		inspectContext: false,
```

Replace with:

```
		inspectSymbol: '',
		inspectLanguages: [],
		inspectContext: false,
```

---

## Patch 2 — pass languages into inspectWorkspace (src/app.mjs)

Search for exactly:

```
	if (options.command === 'inspect') {
		const index = await inspectWorkspace(io.cwd, {
			symbol: options.inspectSymbol,
		});
```

Replace with:

```
	if (options.command === 'inspect') {
		const index = await inspectWorkspace(io.cwd, {
			languages: options.inspectLanguages.length > 0 ? options.inspectLanguages : undefined,
			symbol: options.inspectSymbol,
		});
```

---

## Patch 3 — parse --languages flag (src/app.mjs)

Search for exactly:

```
	} else if (flag === '--symbol') {
		options.inspectSymbol = value;
	}
```

Replace with:

```
	} else if (flag === '--symbol') {
		options.inspectSymbol = value;
	} else if (flag === '--languages') {
		options.inspectLanguages = value.split(',').map((s) => s.trim()).filter(Boolean);
	}
```

---

## Patch 4 — filter files by language in inspectWorkspace (src/code-inspector.mjs)

Search for exactly:

```
	for (const path of files) {
		const language = classifyLanguage(path);
		if (language === 'unknown') {
			continue;
		}
```

Replace with:

```
	for (const path of files) {
		const language = classifyLanguage(path);
		if (language === 'unknown') {
			continue;
		}
		if (options.languages && !options.languages.includes(language)) {
			continue;
		}
```

---

## Patch 5 — add test (test/inspect-command.test.mjs)

Search for exactly:

```
function capture() {
	return {
		output: '',
		write(chunk) {
			this.output += chunk;
		},
	};
}
```

Replace with:

```
function capture() {
	return {
		output: '',
		write(chunk) {
			this.output += chunk;
		},
	};
}

async function writeFixtureAt(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}
```

And add a new test inside the `describe('inspect command')` block. Search for exactly:

```
	it('prints a structural index as JSON', async () => {
```

Replace with:

```
	it('filters files by --languages flag', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-languages-'));
		await writeFixtureAt(cwd, 'src/main.go', 'package main\nfunc Run() {}\n');
		await writeFixtureAt(cwd, 'src/app.py', 'def hello(): pass\n');
		const stdout = capture();

		const result = await main(['inspect', '--languages', 'go', '--json'], {
			cwd,
			env: {},
			stderr: capture(),
			stdout,
		});
		const body = JSON.parse(stdout.output);

		assert.equal(result.ok, true);
		assert.equal(body.files.every((f) => f.language === 'go'), true);
		assert.equal(body.files.some((f) => f.language === 'python'), false);
	});

	it('prints a structural index as JSON', async () => {
```

Output a JSON object with "patches" and "messages". Do not use "files".
