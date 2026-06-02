import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import {
	adaptJsonOutput,
	checkAvailability,
	discoverInspectors,
	inspectWithRegistry,
	mergeInspectorResults,
	runInspectorCommand,
} from '../src/external-inspector-registry.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir() {
	return mkdtemp(join(tmpdir(), 'kodr-ext-inspector-'));
}

async function writeFixture(cwd, path, content) {
	const abs = join(cwd, path);
	await mkdir(dirname(abs), { recursive: true });
	await writeFile(abs, content);
}

/** Build a fake inspector descriptor backed by a Node one-liner script. */
function fakeInspector({
	name = 'fake',
	language = 'go',
	stdout,
	exitCode = 0,
} = {}) {
	return {
		adapt: adaptJsonOutput,
		buildArgs: () => [],
		command: process.execPath, // node itself — always present
		languages: [language],
		name,
		onFailure: 'skip',
		timeout: 5000,
		// Override buildArgs to emit the requested stdout via a -e script
		buildArgs: () => [
			'-e',
			`process.stdout.write(${JSON.stringify(stdout ?? '')}); process.exit(${exitCode});`,
		],
	};
}

// ---------------------------------------------------------------------------
// adaptJsonOutput
// ---------------------------------------------------------------------------

describe('adaptJsonOutput', () => {
	it('parses { files: [...] } envelope', () => {
		const file = {
			imports: [],
			language: 'go',
			lineCount: 5,
			path: 'main.go',
			symbols: [],
		};
		const out = adaptJsonOutput(JSON.stringify({ files: [file] }));
		assert.deepEqual(out, [file]);
	});

	it('parses bare array', () => {
		const file = {
			imports: [],
			language: 'python',
			lineCount: 2,
			path: 'app.py',
			symbols: [],
		};
		const out = adaptJsonOutput(JSON.stringify([file]));
		assert.deepEqual(out, [file]);
	});

	it('returns empty array on malformed JSON', () => {
		assert.deepEqual(adaptJsonOutput('not json'), []);
	});

	it('returns empty array when neither files nor array', () => {
		assert.deepEqual(adaptJsonOutput(JSON.stringify({ other: 1 })), []);
	});
});

// ---------------------------------------------------------------------------
// checkAvailability
// ---------------------------------------------------------------------------

describe('checkAvailability', () => {
	it('returns true for node (always present)', async () => {
		const available = await checkAvailability(process.execPath);
		assert.equal(available, true);
	});

	it('returns false for a nonexistent command', async () => {
		const available = await checkAvailability(
			'__kodr_nonexistent_xyz_8675309__',
		);
		assert.equal(available, false);
	});
});

// ---------------------------------------------------------------------------
// runInspectorCommand
// ---------------------------------------------------------------------------

describe('runInspectorCommand', () => {
	it('captures stdout from a fake command', async () => {
		const payload = {
			files: [
				{
					imports: [],
					language: 'go',
					lineCount: 1,
					path: 'main.go',
					symbols: [],
				},
			],
		};
		const descriptor = fakeInspector({ stdout: JSON.stringify(payload) });
		const result = await runInspectorCommand(descriptor, [], process.cwd());
		assert.equal(result.exitCode, 0);
		const adapted = descriptor.adapt(result.stdout);
		assert.equal(adapted.length, 1);
		assert.equal(adapted[0].path, 'main.go');
	});

	it('reports nonzero exit code', async () => {
		const descriptor = fakeInspector({ exitCode: 1, stdout: '' });
		const result = await runInspectorCommand(descriptor, [], process.cwd());
		assert.equal(result.exitCode, 1);
	});

	it('times out and resolves with timedOut flag', async () => {
		const descriptor = {
			adapt: adaptJsonOutput,
			buildArgs: () => ['-e', 'setTimeout(() => {}, 60000)'],
			command: process.execPath,
			languages: ['go'],
			name: 'slow',
			onFailure: 'skip',
			timeout: 100,
		};
		const result = await runInspectorCommand(descriptor, [], process.cwd());
		assert.equal(result.timedOut, true);
	});
});

// ---------------------------------------------------------------------------
// discoverInspectors
// ---------------------------------------------------------------------------

describe('discoverInspectors', () => {
	it('returns only available inspectors for the given languages', async () => {
		const registry = [
			fakeInspector({ language: 'go', name: 'present' }),
			{
				adapt: adaptJsonOutput,
				buildArgs: () => [],
				command: '__kodr_missing_8675309__',
				languages: ['go'],
				name: 'absent',
				onFailure: 'skip',
				timeout: 1000,
			},
		];
		const found = await discoverInspectors(['go'], registry);
		assert.equal(found.length, 1);
		assert.equal(found[0].name, 'present');
	});

	it('filters by language match', async () => {
		const registry = [fakeInspector({ language: 'rust', name: 'rust-tool' })];
		const found = await discoverInspectors(['go'], registry);
		assert.equal(found.length, 0);
	});
});

// ---------------------------------------------------------------------------
// mergeInspectorResults
// ---------------------------------------------------------------------------

describe('mergeInspectorResults', () => {
	const baseIndex = {
		files: [
			{
				imports: [],
				language: 'go',
				lineCount: 5,
				path: 'main.go',
				_contentLines: [
					{ line: 1, text: 'package main' },
					{ line: 2, text: 'func main() {' },
					{ line: 3, text: 'Run()' },
					{ line: 4, text: '}' },
					{ line: 5, text: 'func Run() {}' },
				],
				symbols: [{ kind: 'function', lineEnd: 5, lineStart: 1, name: 'main' }],
			},
			{
				imports: [],
				language: 'go',
				lineCount: 3,
				path: 'util.go',
				symbols: [],
			},
		],
		languages: { go: 2 },
		references: [],
		symbols: [],
	};

	it('returns base index unchanged when no external files', () => {
		const merged = mergeInspectorResults(baseIndex, []);
		assert.deepEqual(merged, baseIndex);
	});

	it('replaces base file with external file for same path', () => {
		const external = {
			imports: [],
			language: 'go',
			lineCount: 5,
			path: 'main.go',
			symbols: [{ kind: 'function', lineEnd: 5, lineStart: 1, name: 'Run' }],
		};
		const merged = mergeInspectorResults(baseIndex, [external]);
		const mainFile = merged.files.find((f) => f.path === 'main.go');
		assert.equal(mainFile.symbols[0].name, 'Run');
	});

	it('keeps base content lines when external symbols replace a file', () => {
		const external = {
			imports: [],
			language: 'go',
			lineCount: 5,
			path: 'main.go',
			symbols: [{ kind: 'function', lineEnd: 5, lineStart: 5, name: 'Run' }],
		};
		const merged = mergeInspectorResults(baseIndex, [external]);
		const ranked = merged.rankedSymbols.find((symbol) => symbol.name === 'Run');
		assert.equal(ranked.rank.referenceCount, 2);
	});

	it('appends new external files not in base index', () => {
		const external = {
			imports: [],
			language: 'go',
			lineCount: 2,
			path: 'extra.go',
			symbols: [],
		};
		const merged = mergeInspectorResults(baseIndex, [external]);
		assert.equal(merged.files.length, 3);
	});

	it('rebuilds flat symbols list from merged files', () => {
		const external = {
			imports: [],
			language: 'go',
			lineCount: 5,
			path: 'main.go',
			symbols: [
				{ kind: 'function', lineEnd: 5, lineStart: 1, name: 'Replaced' },
			],
		};
		const merged = mergeInspectorResults(baseIndex, [external]);
		assert.ok(merged.symbols.some((s) => s.name === 'Replaced'));
		assert.ok(!merged.symbols.some((s) => s.name === 'main'));
	});
});

// ---------------------------------------------------------------------------
// inspectWithRegistry
// ---------------------------------------------------------------------------

describe('inspectWithRegistry', () => {
	it('falls back to built-in when no inspectors are available', async () => {
		const cwd = await makeTmpDir();
		await writeFixture(cwd, 'main.go', 'package main\nfunc Run() {}\n');
		const emptyRegistry = [];
		const result = await inspectWithRegistry(cwd, {}, emptyRegistry);
		assert.ok(result.files.length > 0);
		assert.deepEqual(result.externalInspectors, []);
	});

	it('uses external inspector output when available', async () => {
		const cwd = await makeTmpDir();
		await writeFixture(cwd, 'main.go', 'package main\nfunc Run() {}\n');

		const externalFile = {
			imports: [],
			language: 'go',
			lineCount: 2,
			path: 'main.go',
			symbols: [
				{ kind: 'function', lineEnd: 2, lineStart: 2, name: 'ExternalRun' },
			],
		};
		const fakeRegistry = [
			fakeInspector({
				language: 'go',
				name: 'fake-go',
				stdout: JSON.stringify({ files: [externalFile] }),
			}),
		];

		const result = await inspectWithRegistry(cwd, {}, fakeRegistry);
		assert.ok(result.externalInspectors.includes('fake-go'));
		assert.ok(result.symbols.some((s) => s.name === 'ExternalRun'));
		assert.ok(result.rankedSymbols.some((s) => s.name === 'ExternalRun'));
	});

	it('ignores a failing external inspector and keeps base index', async () => {
		const cwd = await makeTmpDir();
		await writeFixture(cwd, 'main.go', 'package main\nfunc Base() {}\n');

		const failingRegistry = [
			fakeInspector({
				exitCode: 1,
				language: 'go',
				name: 'failing',
				stdout: '',
			}),
		];
		const result = await inspectWithRegistry(cwd, {}, failingRegistry);

		assert.deepEqual(result.externalInspectors, []);
		assert.ok(result.symbols.some((s) => s.name === 'Base'));
	});
});
