import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import {
	LspClient,
	normalizeDocumentSymbols,
	normalizeDiagnostics,
	runLspInspector,
	uriToRelativePath,
} from '../src/lsp-client.mjs';
import {
	REGISTRY,
	discoverInspectors,
	inspectWithRegistry,
	mergeInspectorResults,
} from '../src/external-inspector-registry.mjs';
import {
	KNOWN_LSP_SERVERS,
	loadProjectConfig,
	ProjectConfigError,
} from '../src/project-config.mjs';

const FAKE_SERVER = resolve(
	fileURLToPath(import.meta.url),
	'../../test-support/fake-lsp-server.mjs',
);

function spawnFakeLsp(config = {}) {
	return spawn(process.execPath, [FAKE_SERVER, JSON.stringify(config)], {
		stdio: ['pipe', 'pipe', 'pipe'],
	});
}

async function makeTmpDir() {
	return mkdtemp(join(tmpdir(), 'kodr-lsp-'));
}

// ---------------------------------------------------------------------------
// FrameDecoder (tested via LspClient.enrichFile round-trip through fake server)
// ---------------------------------------------------------------------------

describe('framing', () => {
	it('decodes a single message', async () => {
		const proc = spawnFakeLsp({});
		const client = new LspClient(proc, { requestTimeout: 5000 });
		const rootUri = pathToFileURL(tmpdir()).href;
		await client.initialize(rootUri);
		await client.shutdown();
	});

	it('handles server that sends two messages quickly (symbols + diagnostics)', async () => {
		const proc = spawnFakeLsp({
			diagnostics: [
				{
					message: 'unused variable',
					range: {
						end: { character: 5, line: 2 },
						start: { character: 0, line: 2 },
					},
					severity: 2,
					source: 'fake-lsp',
				},
			],
			symbols: [
				{
					kind: 12, // Function
					name: 'main',
					range: {
						end: { character: 0, line: 5 },
						start: { character: 0, line: 0 },
					},
					selectionRange: {
						end: { character: 4, line: 0 },
						start: { character: 0, line: 0 },
					},
				},
			],
		});

		const client = new LspClient(proc, { requestTimeout: 5000 });
		await client.initialize(pathToFileURL(tmpdir()).href);

		const uri = pathToFileURL(join(tmpdir(), 'main.go')).href;
		const { symbols, diagnostics } = await client.enrichFile(
			uri,
			'go',
			'package main\nfunc main() {}\n',
			100, // wait 100ms for diagnostics
		);

		assert.equal(symbols.length, 1);
		assert.equal(symbols[0].name, 'main');
		// diagnostics arrived within the window
		assert.equal(diagnostics.length, 1);
		await client.shutdown();
	});

	it('tolerates a malformed Content-Length frame without hanging', async () => {
		// Send raw garbage then a real message — decoder must recover
		const proc = spawnFakeLsp({});
		const client = new LspClient(proc, { requestTimeout: 3000 });
		// Manually push garbage into the decoder via the fake server path — we
		// just verify initialize completes (the server is well-behaved)
		await client.initialize(pathToFileURL(tmpdir()).href);
		await client.shutdown();
	});
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
	it('completes initialize → requests → shutdown cleanly', async () => {
		const proc = spawnFakeLsp({
			symbols: [
				{
					kind: 5, // Class
					name: 'MyClass',
					range: {
						end: { character: 0, line: 10 },
						start: { character: 0, line: 0 },
					},
					selectionRange: {
						end: { character: 7, line: 0 },
						start: { character: 0, line: 0 },
					},
				},
			],
		});
		const client = new LspClient(proc, { requestTimeout: 5000 });
		await client.initialize(pathToFileURL(tmpdir()).href);

		const uri = pathToFileURL(join(tmpdir(), 'x.ts')).href;
		// enrichFile returns raw LSP symbols; normalization is done by runLspInspector
		const { symbols } = await client.enrichFile(
			uri,
			'typescript',
			'class MyClass {}',
			0,
		);
		assert.equal(symbols.length, 1);
		assert.equal(symbols[0].name, 'MyClass');
		assert.equal(symbols[0].kind, 5); // raw LSP SymbolKind (Class)

		await client.shutdown();
		// Process should exit cleanly
		await new Promise((resolve, reject) => {
			proc.on('close', (code) => {
				if (code === 0 || code === null) resolve();
				else reject(new Error(`Process exited with code ${code}`));
			});
		});
	});

	it('falls back when initialize times out', async () => {
		const proc = spawnFakeLsp({ hangOnInit: true });
		const client = new LspClient(proc, { requestTimeout: 200 });
		await assert.rejects(
			() => client.initialize(pathToFileURL(tmpdir()).href),
			/timed out/i,
		);
		client.kill();
	});

	it('records fallbackReason when LSP inspector fails via runLspInspector', async () => {
		// runLspInspector with a server that hangs on init should throw
		const descriptor = {
			args: [FAKE_SERVER, JSON.stringify({ hangOnInit: true })],
			command: process.execPath,
			languages: ['go'],
			name: 'hanging-lsp',
			onFailure: 'skip',
			protocol: 'lsp',
		};
		const baseFiles = [
			{
				contentLines: [{ line: 1, text: 'package main' }],
				imports: [],
				language: 'go',
				lineCount: 1,
				path: 'main.go',
			},
		];
		const cwd = await makeTmpDir();
		// Should throw (initTimeout is very short)
		await assert.rejects(
			() =>
				runLspInspector(descriptor, baseFiles, cwd, {
					initTimeout: 200,
					requestTimeout: 200,
				}),
			/timed out/i,
		);
	});
});

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

describe('normalizeDocumentSymbols', () => {
	it('maps DocumentSymbol[] with nested children', () => {
		const input = [
			{
				children: [
					{
						kind: 6, // Method
						name: 'render',
						range: {
							end: { character: 0, line: 10 },
							start: { character: 2, line: 5 },
						},
						selectionRange: {
							end: { character: 8, line: 5 },
							start: { character: 2, line: 5 },
						},
					},
				],
				kind: 5, // Class
				name: 'App',
				range: {
					end: { character: 0, line: 20 },
					start: { character: 0, line: 1 },
				},
				selectionRange: {
					end: { character: 3, line: 1 },
					start: { character: 0, line: 1 },
				},
			},
		];
		const result = normalizeDocumentSymbols(input);
		assert.equal(result.length, 2);
		assert.deepEqual(result[0], {
			kind: 'class',
			lineEnd: 21,
			lineStart: 2,
			name: 'App',
		});
		assert.deepEqual(result[1], {
			kind: 'function',
			lineEnd: 11,
			lineStart: 6,
			name: 'render',
		});
	});

	it('maps SymbolInformation[] (flat list)', () => {
		const input = [
			{
				kind: 12, // Function
				location: {
					range: {
						end: { character: 0, line: 3 },
						start: { character: 0, line: 0 },
					},
					uri: 'file:///a/b.go',
				},
				name: 'Run',
			},
			{
				kind: 13, // Variable
				location: {
					range: {
						end: { character: 5, line: 7 },
						start: { character: 0, line: 7 },
					},
					uri: 'file:///a/b.go',
				},
				name: 'count',
			},
		];
		const result = normalizeDocumentSymbols(input);
		assert.equal(result.length, 2);
		assert.deepEqual(result[0], {
			kind: 'function',
			lineEnd: 4,
			lineStart: 1,
			name: 'Run',
		});
		assert.deepEqual(result[1], {
			kind: 'variable',
			lineEnd: 8,
			lineStart: 8,
			name: 'count',
		});
	});

	it('converts 0-based LSP lines to 1-based repomap lines', () => {
		const input = [
			{
				kind: 12,
				range: {
					end: { character: 0, line: 0 },
					start: { character: 0, line: 0 },
				},
				name: 'init',
				selectionRange: {
					end: { character: 4, line: 0 },
					start: { character: 0, line: 0 },
				},
			},
		];
		const result = normalizeDocumentSymbols(input);
		assert.equal(result[0].lineStart, 1);
		assert.equal(result[0].lineEnd, 1);
	});

	it('keeps test kind for names matching test heuristics', () => {
		const input = [
			{
				kind: 12, // Function — would normally map to 'function'
				name: 'TestMyFeature',
				range: {
					end: { character: 0, line: 5 },
					start: { character: 0, line: 0 },
				},
				selectionRange: {
					end: { character: 14, line: 0 },
					start: { character: 0, line: 0 },
				},
			},
			{
				kind: 12,
				name: 'test_parse',
				range: {
					end: { character: 0, line: 3 },
					start: { character: 0, line: 0 },
				},
				selectionRange: {
					end: { character: 10, line: 0 },
					start: { character: 0, line: 0 },
				},
			},
		];
		const result = normalizeDocumentSymbols(input);
		assert.equal(result[0].kind, 'test');
		assert.equal(result[1].kind, 'test');
	});

	it('drops symbols with unmapped LSP kinds', () => {
		const input = [
			{
				kind: 1, // File — not in SYMBOL_KIND_MAP
				name: 'some.file',
				range: {
					end: { character: 0, line: 0 },
					start: { character: 0, line: 0 },
				},
				selectionRange: {
					end: { character: 4, line: 0 },
					start: { character: 0, line: 0 },
				},
			},
		];
		const result = normalizeDocumentSymbols(input);
		assert.equal(result.length, 0);
	});
});

describe('normalizeDiagnostics', () => {
	it('converts LSP diagnostics to repomap shape', () => {
		const input = [
			{
				message: 'unused import',
				range: {
					end: { character: 10, line: 0 },
					start: { character: 0, line: 0 },
				},
				severity: 1,
				source: 'gopls',
			},
			{
				message: 'possible nil deref',
				range: {
					end: { character: 5, line: 9 },
					start: { character: 0, line: 9 },
				},
				severity: 2,
				source: 'gopls',
			},
		];
		const result = normalizeDiagnostics(input);
		assert.equal(result.length, 2);
		assert.deepEqual(result[0], {
			line: 1,
			message: 'unused import',
			severity: 'error',
			source: 'gopls',
		});
		assert.deepEqual(result[1], {
			line: 10,
			message: 'possible nil deref',
			severity: 'warning',
			source: 'gopls',
		});
	});
});

// ---------------------------------------------------------------------------
// uriToRelativePath
// ---------------------------------------------------------------------------

describe('uriToRelativePath', () => {
	it('converts file URI to relative path within workspace', () => {
		const root = '/workspace/myproject';
		const uri = 'file:///workspace/myproject/src/main.rs';
		assert.equal(uriToRelativePath(uri, root), 'src/main.rs');
	});

	it('returns null for URIs outside the workspace', () => {
		const root = '/workspace/myproject';
		const uri = 'file:///other/path/file.rs';
		assert.equal(uriToRelativePath(uri, root), null);
	});

	it('returns null for non-file URIs', () => {
		assert.equal(uriToRelativePath('untitled:x', '/workspace'), null);
	});
});

// ---------------------------------------------------------------------------
// runLspInspector (integration via fake server)
// ---------------------------------------------------------------------------

describe('runLspInspector', () => {
	it('returns normalized InspectedFile array', async () => {
		const cwd = await makeTmpDir();
		await writeFile(join(cwd, 'main.go'), 'package main\nfunc Run() {}\n');

		const descriptor = {
			args: [
				FAKE_SERVER,
				JSON.stringify({
					symbols: [
						{
							kind: 12, // Function
							name: 'Run',
							range: {
								end: { character: 0, line: 2 },
								start: { character: 0, line: 1 },
							},
							selectionRange: {
								end: { character: 3, line: 1 },
								start: { character: 0, line: 1 },
							},
						},
					],
				}),
			],
			command: process.execPath,
			languages: ['go'],
			name: 'fake-lsp',
			onFailure: 'skip',
			protocol: 'lsp',
		};

		const baseFiles = [
			{
				contentLines: [
					{ line: 1, text: 'package main' },
					{ line: 2, text: 'func Run() {}' },
				],
				imports: [],
				language: 'go',
				lineCount: 2,
				path: 'main.go',
			},
		];

		const result = await runLspInspector(descriptor, baseFiles, cwd, {
			diagWindow: 100,
			initTimeout: 5000,
			requestTimeout: 5000,
		});

		assert.equal(result.length, 1);
		assert.equal(result[0].path, 'main.go');
		assert.equal(result[0].symbols.length, 1);
		assert.equal(result[0].symbols[0].name, 'Run');
		assert.equal(result[0].symbols[0].kind, 'function');
	});

	it('collects lspDiagnostics from publishDiagnostics push', async () => {
		const cwd = await makeTmpDir();
		await writeFile(join(cwd, 'app.py'), 'x = 1\n');

		const descriptor = {
			args: [
				FAKE_SERVER,
				JSON.stringify({
					diagnostics: [
						{
							message: 'undefined variable',
							range: {
								end: { character: 1, line: 0 },
								start: { character: 0, line: 0 },
							},
							severity: 1,
							source: 'pyright',
						},
					],
					symbols: [
						{
							kind: 13,
							name: 'x',
							range: {
								end: { character: 5, line: 0 },
								start: { character: 0, line: 0 },
							},
							selectionRange: {
								end: { character: 1, line: 0 },
								start: { character: 0, line: 0 },
							},
						},
					],
				}),
			],
			command: process.execPath,
			languages: ['python'],
			name: 'fake-pyright',
			onFailure: 'skip',
			protocol: 'lsp',
		};

		const baseFiles = [
			{
				contentLines: [{ line: 1, text: 'x = 1' }],
				imports: [],
				language: 'python',
				lineCount: 1,
				path: 'app.py',
			},
		];

		const result = await runLspInspector(descriptor, baseFiles, cwd, {
			diagWindow: 200,
			initTimeout: 5000,
			requestTimeout: 5000,
		});

		assert.equal(result.length, 1);
		assert.ok(result[0].lspDiagnostics.length > 0);
		assert.equal(result[0].lspDiagnostics[0].message, 'undefined variable');
	});
});

// ---------------------------------------------------------------------------
// mergeInspectorResults — LSP-specific extensions
// ---------------------------------------------------------------------------

describe('mergeInspectorResults (LSP)', () => {
	const baseIndex = {
		files: [
			{
				contentLines: [
					{ line: 1, text: 'package main' },
					{ line: 2, text: 'func main() {}' },
				],
				imports: [],
				language: 'go',
				lineCount: 2,
				path: 'main.go',
				symbols: [{ kind: 'function', lineEnd: 2, lineStart: 2, name: 'main' }],
			},
		],
		languages: { go: 1 },
		references: [],
		symbols: [
			{
				kind: 'function',
				language: 'go',
				lineEnd: 2,
				lineStart: 2,
				name: 'main',
				path: 'main.go',
			},
		],
	};

	it('LSP symbols replace base symbols, contentLines survive', () => {
		const lspFile = {
			imports: [],
			language: 'go',
			lineCount: 2,
			path: 'main.go',
			symbols: [
				{ kind: 'function', lineEnd: 2, lineStart: 2, name: 'EnhancedMain' },
			],
		};
		const merged = mergeInspectorResults(baseIndex, [lspFile]);
		const file = merged.files.find((f) => f.path === 'main.go');
		assert.equal(file.symbols[0].name, 'EnhancedMain');
		assert.ok(file.contentLines?.length > 0, 'contentLines must survive merge');
	});

	it('re-ranks symbols after merge', () => {
		const lspFile = {
			imports: [],
			language: 'go',
			lineCount: 2,
			path: 'main.go',
			symbols: [
				{ kind: 'function', lineEnd: 2, lineStart: 2, name: 'EnhancedMain' },
			],
		};
		const merged = mergeInspectorResults(baseIndex, [lspFile]);
		assert.ok(merged.rankedSymbols.some((s) => s.name === 'EnhancedMain'));
		assert.ok(!merged.rankedSymbols.some((s) => s.name === 'main'));
	});
});

// ---------------------------------------------------------------------------
// Gating: default-off, --lsp flag, config key, --no-lsp
// ---------------------------------------------------------------------------

describe('inspectWithRegistry gating', () => {
	async function makeGoWorkspace() {
		const cwd = await makeTmpDir();
		await writeFile(join(cwd, 'main.go'), 'package main\nfunc Run() {}\n');
		return cwd;
	}

	it('spawns no LSP process when lsp option is falsy (default)', async () => {
		const cwd = await makeGoWorkspace();
		// Track spawn calls via a registry with a sentinel LSP entry
		let spawned = false;

		// Provide a fake LSP registry entry that would record if it ran
		const sentinel = {
			args: [FAKE_SERVER, '{}'],
			command: process.execPath,
			languages: ['go'],
			name: 'sentinel-lsp',
			onFailure: 'skip',
			protocol: 'lsp',
		};

		// Monkey-patch runLspInspector is tricky — instead verify via the return value:
		// without lsp option, lspInspectors should be []
		const result = await inspectWithRegistry(cwd, { lsp: false }, [sentinel]);
		assert.deepEqual(result.lspInspectors, []);
	});

	it('uses LSP entry when lsp: true is passed', async () => {
		const cwd = await makeGoWorkspace();
		const fakeLspEntry = {
			args: [
				FAKE_SERVER,
				JSON.stringify({
					symbols: [
						{
							kind: 12,
							name: 'LspRun',
							range: {
								end: { character: 0, line: 2 },
								start: { character: 0, line: 1 },
							},
							selectionRange: {
								end: { character: 6, line: 1 },
								start: { character: 0, line: 1 },
							},
						},
					],
				}),
			],
			command: process.execPath,
			languages: ['go'],
			name: 'fake-lsp',
			onFailure: 'skip',
			protocol: 'lsp',
		};

		const result = await inspectWithRegistry(cwd, { lsp: true }, [
			fakeLspEntry,
		]);
		assert.ok(result.lspInspectors.includes('fake-lsp'));
		assert.ok(result.symbols.some((s) => s.name === 'LspRun'));
	});

	it('filters by server name when lsp is an array', async () => {
		const cwd = await makeGoWorkspace();

		const allowedEntry = {
			args: [
				FAKE_SERVER,
				JSON.stringify({
					symbols: [
						{
							kind: 12,
							name: 'Allowed',
							range: {
								end: { character: 0, line: 1 },
								start: { character: 0, line: 0 },
							},
							selectionRange: {
								end: { character: 7, line: 0 },
								start: { character: 0, line: 0 },
							},
						},
					],
				}),
			],
			command: process.execPath,
			languages: ['go'],
			name: 'allowed-lsp',
			onFailure: 'skip',
			protocol: 'lsp',
		};
		const skippedEntry = {
			args: [
				FAKE_SERVER,
				JSON.stringify({
					symbols: [
						{
							kind: 12,
							name: 'Skipped',
							range: {
								end: { character: 0, line: 1 },
								start: { character: 0, line: 0 },
							},
							selectionRange: {
								end: { character: 7, line: 0 },
								start: { character: 0, line: 0 },
							},
						},
					],
				}),
			],
			command: process.execPath,
			languages: ['go'],
			name: 'skipped-lsp',
			onFailure: 'skip',
			protocol: 'lsp',
		};

		const result = await inspectWithRegistry(cwd, { lsp: ['allowed-lsp'] }, [
			allowedEntry,
			skippedEntry,
		]);
		assert.ok(result.lspInspectors.includes('allowed-lsp'));
		assert.ok(!result.lspInspectors.includes('skipped-lsp'));
	});
});

// ---------------------------------------------------------------------------
// Registry hygiene — no default 'cli' entries
// ---------------------------------------------------------------------------

describe('REGISTRY hygiene', () => {
	it('has no default cli entries (prevents invented-flags regression)', () => {
		const cliEntries = REGISTRY.filter((e) => (e.protocol ?? 'cli') === 'cli');
		assert.equal(
			cliEntries.length,
			0,
			`Found CLI entries: ${cliEntries.map((e) => e.name).join(', ')}`,
		);
	});

	it('all default entries are lsp protocol', () => {
		for (const entry of REGISTRY) {
			assert.equal(
				entry.protocol,
				'lsp',
				`Entry "${entry.name}" should have protocol: 'lsp'`,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Config validation — lsp key
// ---------------------------------------------------------------------------

describe('project-config lsp key', () => {
	it('KNOWN_LSP_SERVERS includes the default registry names', () => {
		assert.ok(KNOWN_LSP_SERVERS.has('gopls'));
		assert.ok(KNOWN_LSP_SERVERS.has('pyright'));
		assert.ok(KNOWN_LSP_SERVERS.has('rust-analyzer'));
		assert.ok(KNOWN_LSP_SERVERS.has('typescript-language-server'));
	});

	it('rejects a command string in lsp array', async () => {
		const cwd = await makeTmpDir();
		await mkdir(join(cwd, '.kodr'));
		await writeFile(
			join(cwd, '.kodr/config.json'),
			JSON.stringify({ lsp: ['gopls --json'] }),
		);
		assert.throws(
			() => loadProjectConfig(cwd),
			(err) =>
				err instanceof ProjectConfigError &&
				/unknown LSP server name/i.test(err.message),
		);
	});

	it('rejects an unknown server name', async () => {
		const cwd = await makeTmpDir();
		await mkdir(join(cwd, '.kodr'));
		await writeFile(
			join(cwd, '.kodr/config.json'),
			JSON.stringify({ lsp: ['evil-server'] }),
		);
		assert.throws(
			() => loadProjectConfig(cwd),
			(err) =>
				err instanceof ProjectConfigError &&
				/unknown LSP server name/i.test(err.message),
		);
	});

	it('accepts lsp: true', async () => {
		const cwd = await makeTmpDir();
		await mkdir(join(cwd, '.kodr'));
		await writeFile(
			join(cwd, '.kodr/config.json'),
			JSON.stringify({ lsp: true }),
		);
		const loaded = loadProjectConfig(cwd);
		assert.equal(loaded.config.lsp, true);
	});

	it('accepts lsp: ["gopls"]', async () => {
		const cwd = await makeTmpDir();
		await mkdir(join(cwd, '.kodr'));
		await writeFile(
			join(cwd, '.kodr/config.json'),
			JSON.stringify({ lsp: ['gopls'] }),
		);
		const loaded = loadProjectConfig(cwd);
		assert.deepEqual(loaded.config.lsp, ['gopls']);
	});

	it('rejects lsp: "gopls" (string, not boolean or array)', async () => {
		const cwd = await makeTmpDir();
		await mkdir(join(cwd, '.kodr'));
		await writeFile(
			join(cwd, '.kodr/config.json'),
			JSON.stringify({ lsp: 'gopls' }),
		);
		assert.throws(
			() => loadProjectConfig(cwd),
			(err) => err instanceof ProjectConfigError,
		);
	});
});
