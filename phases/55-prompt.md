You are editing an existing codebase. Use ONLY "patches" — never "files" — for all changes. All target files already exist.

## Task

Add a `kodr registry` subcommand to `src/app.mjs` that reports which external
inspectors from the registry are available in the current environment.

## Patch 1 — import discoverInspectors and REGISTRY in src/app.mjs

The imports section of `src/app.mjs` currently ends with:

```
import { inspectWorkspace } from './code-inspector.mjs';
```

Add an import line after it. Search for exactly:

```
import { inspectWorkspace } from './code-inspector.mjs';
```

Replace with:

```
import { inspectWorkspace } from './code-inspector.mjs';
import { checkAvailability, REGISTRY } from './external-inspector-registry.mjs';
```

## Patch 2 — add the registry command handler in src/app.mjs

The inspect command handler in `src/app.mjs` ends with:

```
		return { ok: true, command: 'inspect', index };
	}
```

Add the registry handler after it. Search for exactly:

```
		return { ok: true, command: 'inspect', index };
	}
```

Replace with:

```
		return { ok: true, command: 'inspect', index };
	}

	if (options.command === 'registry') {
		const results = await Promise.all(
			REGISTRY.map(async (entry) => ({
				available: await checkAvailability(entry.command),
				languages: entry.languages,
				name: entry.name,
			})),
		);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
		} else {
			for (const entry of results) {
				const mark = entry.available ? '✓' : '✗';
				const langs = entry.languages.join(',');
				io.stdout.write(`${entry.name.padEnd(36)}${langs.padEnd(24)}${mark}\n`);
			}
		}
		return { ok: true, command: 'registry', results };
	}
```

## Patch 3 — add help text in src/app.mjs

The help text contains this line:

```
  kodr inspect [--symbol name] [--json]
```

Search for exactly:

```
  kodr inspect [--symbol name] [--json]
```

Replace with:

```
  kodr inspect [--symbol name] [--json]
  kodr registry [--json]
```

## New file — test/registry-command.test.mjs

Create this new test file using the "files" field (it does not exist yet):

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from '../src/app.mjs';

describe('registry command', () => {
	it('returns an array of inspector entries with name, languages, available', async () => {
		const stdout = capture();
		const result = await main(['registry', '--json'], {
			cwd: process.cwd(),
			env: {},
			stderr: capture(),
			stdout,
		});
		const entries = JSON.parse(stdout.output);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'registry');
		assert.ok(Array.isArray(entries));
		assert.ok(entries.length > 0);
		for (const entry of entries) {
			assert.ok(typeof entry.name === 'string');
			assert.ok(Array.isArray(entry.languages));
			assert.ok(typeof entry.available === 'boolean');
		}
	});
});

function capture() {
	return {
		output: '',
		write(chunk) {
			this.output += chunk;
		},
	};
}
```

Output a JSON object with "patches" (for the three app.mjs changes) and "files" (for the new test file) and "messages".
