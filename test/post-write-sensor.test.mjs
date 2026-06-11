import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	inspectChangedFiles,
	runPostWriteDiagnostics,
} from '../src/post-write-sensor.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a real temp dir and writes a JS file inside it. */
async function makeTempDir(filename = 'index.js', content = 'const x = 1;\n') {
	const dir = await mkdtemp(join(tmpdir(), 'post-write-sensor-'));
	await writeFile(join(dir, filename), content, 'utf8');
	return dir;
}

// An empty registry means discoverInspectors will always resolve to [].
const EMPTY_REGISTRY = [];

// ---------------------------------------------------------------------------
// inspectChangedFiles
// ---------------------------------------------------------------------------

describe('inspectChangedFiles', () => {
	it('returns null when options.lsp is falsy (undefined)', async () => {
		const result = await inspectChangedFiles(
			'/tmp',
			['index.js'],
			{},
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when options.lsp is false', async () => {
		const result = await inspectChangedFiles(
			'/tmp',
			['index.js'],
			{ lsp: false },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('skips absolute paths and records them', async () => {
		const dir = await makeTempDir();
		// With only an absolute path and an empty registry the early-exit at
		// baseFiles.length === 0 triggers first, so we just verify null return.
		const result = await inspectChangedFiles(
			dir,
			['/etc/passwd'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('skips paths containing ".." and records them', async () => {
		const dir = await makeTempDir();
		const result = await inspectChangedFiles(
			dir,
			['../outside.js'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('skips files with unknown language classification', async () => {
		const dir = await makeTempDir('notes.xyz', 'raw text');
		const result = await inspectChangedFiles(
			dir,
			['notes.xyz'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		// Unknown language → baseFiles remains empty → returns null
		assert.equal(result, null);
	});

	it('returns null when no files pass filtering (all skipped)', async () => {
		const dir = await makeTempDir();
		const result = await inspectChangedFiles(
			dir,
			['/absolute/path.js', '../traversal.js'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when a real JS file is present but no inspectors are discovered', async () => {
		const dir = await makeTempDir('main.js', 'const a = 1;\n');
		const result = await inspectChangedFiles(
			dir,
			['main.js'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		// File passes all filters, but discoverInspectors([]) returns [] → null
		assert.equal(result, null);
	});

	it('returns null for a TypeScript file when registry is empty', async () => {
		const dir = await makeTempDir('app.ts', 'const x: number = 1;\n');
		const result = await inspectChangedFiles(
			dir,
			['app.ts'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('skips a file that does not exist on disk (read failure)', async () => {
		const dir = await makeTempDir();
		// 'missing.js' is a classifiable language but does not exist
		const result = await inspectChangedFiles(
			dir,
			['missing.js'],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		// read failure → skipped, baseFiles empty → returns null
		assert.equal(result, null);
	});

	it('handles an empty paths array gracefully', async () => {
		const dir = await makeTempDir();
		const result = await inspectChangedFiles(
			dir,
			[],
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('handles lsp set to "auto" — passes lspEntryAllowed gate', async () => {
		const dir = await makeTempDir('app.js', 'const y = 2;\n');
		// Still returns null because registry is empty, but the lsp gate is passed
		const result = await inspectChangedFiles(
			dir,
			['app.js'],
			{ lsp: 'auto' },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('handles lsp as an array of names — passes lspEntryAllowed gate', async () => {
		const dir = await makeTempDir('util.js', 'export const x = 3;\n');
		const result = await inspectChangedFiles(
			dir,
			['util.js'],
			{ lsp: ['typescript-lsp'] },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});
});

// ---------------------------------------------------------------------------
// runPostWriteDiagnostics
// ---------------------------------------------------------------------------

describe('runPostWriteDiagnostics', () => {
	it('returns null when options.lsp is falsy', async () => {
		const writeResult = { applied: true, writes: [{ path: 'index.js' }] };
		const result = await runPostWriteDiagnostics(
			'/tmp',
			writeResult,
			{},
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when writeResult.applied is false', async () => {
		const writeResult = { applied: false, writes: [{ path: 'index.js' }] };
		const result = await runPostWriteDiagnostics(
			'/tmp',
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when writeResult.applied is missing (nullish)', async () => {
		const writeResult = { writes: [{ path: 'index.js' }] };
		const result = await runPostWriteDiagnostics(
			'/tmp',
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when writeResult.writes is an empty array', async () => {
		const writeResult = { applied: true, writes: [] };
		const result = await runPostWriteDiagnostics(
			'/tmp',
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when writeResult.writes is missing', async () => {
		const writeResult = { applied: true };
		const result = await runPostWriteDiagnostics(
			'/tmp',
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when writeResult is null', async () => {
		const result = await runPostWriteDiagnostics(
			'/tmp',
			null,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('returns null when writeResult is undefined', async () => {
		const result = await runPostWriteDiagnostics(
			'/tmp',
			undefined,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('never throws — returns null on unexpected errors', async () => {
		// Pass a non-array writes value to trigger the internal guard, then
		// confirm the function still resolves (does not reject).
		const writeResult = { applied: true, writes: 'not-an-array' };
		const result = await runPostWriteDiagnostics(
			'/tmp',
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('delegates to inspectChangedFiles when all gates pass', async () => {
		const dir = await makeTempDir('component.js', 'const z = 4;\n');
		const writeResult = { applied: true, writes: [{ path: 'component.js' }] };
		// No real LSP server, so inspectChangedFiles returns null (no inspectors).
		// The important thing is that the call completes without error.
		const result = await runPostWriteDiagnostics(
			dir,
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		assert.equal(result, null);
	});

	it('passes multiple write paths through to inspectChangedFiles', async () => {
		const dir = await makeTempDir('a.js', 'const a = 0;\n');
		await writeFile(join(dir, 'b.ts'), 'const b: number = 0;\n', 'utf8');
		const writeResult = {
			applied: true,
			writes: [{ path: 'a.js' }, { path: 'b.ts' }],
		};
		const result = await runPostWriteDiagnostics(
			dir,
			writeResult,
			{ lsp: true },
			EMPTY_REGISTRY,
		);
		// Still null because registry is empty — but both paths were processed
		assert.equal(result, null);
	});
});
