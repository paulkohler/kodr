import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ToolError, ToolRunner } from '../src/tools.mjs';

describe('bounded tools', () => {
	it('supports list_files, read_file, write_file, and run_command', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-tools-'));
		await writeFile(join(cwd, 'a.mjs'), 'export {};\n', 'utf8');
		const runner = new ToolRunner(cwd, { maxCalls: 5 });

		assert.deepEqual(await runner.call('list_files'), ['a.mjs']);
		assert.equal(
			await runner.call('read_file', { path: 'a.mjs' }),
			'export {};\n',
		);

		const write = await runner.call('write_file', {
			apply: true,
			content: 'export const x = 1;\n',
			path: 'a.mjs',
		});
		assert.equal(write.applied, true);
		assert.equal(
			await readFile(join(cwd, 'a.mjs'), 'utf8'),
			'export const x = 1;\n',
		);

		const result = await runner.call('run_command', {
			command: 'node --check a.mjs',
			timeoutMs: 1000,
		});
		assert.equal(result.ok, true);
	});

	it('blocks local fetch_url targets', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-tools-fetch-'));
		const runner = new ToolRunner(cwd);

		await assert.rejects(
			() => runner.call('fetch_url', { url: 'http://localhost:1234' }),
			ToolError,
		);
	});

	it('stops budget exhaustion and duplicate calls', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-tools-budget-'));
		const runner = new ToolRunner(cwd, { maxCalls: 1 });

		await runner.call('list_files');
		await assert.rejects(
			() => runner.call('read_file', { path: 'x' }),
			/budget/u,
		);

		const duplicateRunner = new ToolRunner(cwd, { maxCalls: 3 });
		await duplicateRunner.call('list_files');
		await assert.rejects(
			() => duplicateRunner.call('list_files'),
			/Duplicate/u,
		);
	});
});
