import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fetchUrl, ToolError, ToolRunner } from '../src/tools.mjs';

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

	it('jails read_file paths and symlink targets', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'koder-tools-jail-parent-'));
		const cwd = join(parent, 'workspace');
		await mkdir(cwd, { recursive: true });
		await writeFile(join(parent, 'secret.txt'), 'secret', 'utf8');
		await writeFile(join(cwd, 'safe.txt'), 'safe', 'utf8');
		await symlink(join(parent, 'secret.txt'), join(cwd, 'link.txt'));
		const runner = new ToolRunner(cwd, { maxCalls: 4 });

		await assert.rejects(
			() => runner.call('read_file', { path: '../secret.txt' }),
			/Parent path segments/u,
		);
		await assert.rejects(
			() => runner.call('read_file', { path: join(parent, 'secret.txt') }),
			/Absolute paths/u,
		);
		await assert.rejects(
			() => runner.call('read_file', { path: 'link.txt' }),
			/Symlink target/u,
		);
		assert.equal(await runner.call('read_file', { path: 'safe.txt' }), 'safe');
	});

	it('blocks resolved private fetch targets', async () => {
		await assert.rejects(
			() =>
				fetchUrl('https://private.example.test', {
					lookupHost: async () => [{ address: '10.1.2.3' }],
				}),
			/Blocked local or private/u,
		);
	});

	it('caps fetch_url response bodies', async () => {
		await assert.rejects(
			() =>
				fetchUrl('https://public.example.test', {
					fetchImpl: async () => new Response('too long'),
					lookupHost: async () => [{ address: '93.184.216.34' }],
					maxBytes: 3,
				}),
			/exceeded 3 bytes/u,
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
