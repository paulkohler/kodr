import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fetchUrl, ToolError, ToolRunner } from '../src/tools.mjs';

describe('bounded tools', () => {
	it('supports list_files, read_file, write_file, and run_command', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-'));
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
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-fetch-'));
		const runner = new ToolRunner(cwd);

		await assert.rejects(
			() => runner.call('fetch_url', { url: 'http://localhost:1234' }),
			ToolError,
		);
	});

	it('jails read_file paths and symlink targets', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'kodr-tools-jail-parent-'));
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

	it('refuses to follow redirects to keep the SSRF guard intact', async () => {
		let calls = 0;
		await assert.rejects(
			() =>
				fetchUrl('https://public.example.test', {
					fetchImpl: async () => {
						calls += 1;
						return new Response(null, {
							status: 302,
							headers: { location: 'http://169.254.169.254/latest/meta-data/' },
						});
					},
					lookupHost: async () => [{ address: '93.184.216.34' }],
				}),
			/Refusing to follow redirect/u,
		);
		// The redirect target is never fetched — only the original request runs.
		assert.equal(calls, 1);
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
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-budget-'));
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

	it('exposes bounded task management tools', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-tasks-'));
		const runner = new ToolRunner(cwd, {
			maxCalls: 3,
			task: 'build example',
		});

		const initial = await runner.call('list_tasks');
		assert.equal(
			initial.tasks.find((task) => task.id === 'verify').status,
			'pending',
		);

		const updated = await runner.call('update_task', {
			id: 'verify',
			note: 'Example tests passed.',
			status: 'completed',
		});

		assert.equal(
			updated.tasks.find((task) => task.id === 'verify').status,
			'completed',
		);
		assert.equal(
			updated.tasks.find((task) => task.id === 'verify').note,
			'Example tests passed.',
		);
	});

	it('runs hooks around tool calls', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-hooks-'));
		await writeFile(join(cwd, 'a.txt'), 'alpha', 'utf8');
		await writeFile(join(cwd, 'b.txt'), 'bravo', 'utf8');
		const observed = [];
		const runner = new ToolRunner(cwd, {
			hooks: {
				post_tool_use: [
					(payload) => {
						observed.push(`${payload.tool}:${payload.result}`);
					},
				],
				pre_tool_use: [
					(payload) => {
						return {
							action: 'mutate',
							payload: {
								...payload,
								input: {
									...payload.input,
									path: 'b.txt',
								},
							},
						};
					},
				],
			},
		});

		assert.equal(await runner.call('read_file', { path: 'a.txt' }), 'bravo');
		assert.deepEqual(observed, ['read_file:bravo']);
	});

	it('lets pre-tool hooks block calls', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-hook-block-'));
		const runner = new ToolRunner(cwd, {
			hooks: {
				pre_tool_use: [
					() => ({
						action: 'block',
						reason: 'Writes are disabled by hook.',
					}),
				],
			},
		});

		await assert.rejects(
			() =>
				runner.call('write_file', {
					content: 'x',
					path: 'x.txt',
				}),
			/Writes are disabled by hook/u,
		);
	});

	it('enforces permission policy before tool effects', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-policy-'));
		await writeFile(join(cwd, 'README.md'), 'readme', 'utf8');
		const runner = new ToolRunner(cwd, {
			policy: {
				allowApply: false,
				allowNetwork: false,
				allowedCommands: ['node --test'],
				allowedReadPaths: ['src'],
				allowedWritePaths: ['notes'],
			},
		});

		await assert.rejects(
			() => runner.call('read_file', { path: 'README.md' }),
			/outside allowed read/u,
		);
		await assert.rejects(
			() =>
				runner.call('write_file', {
					apply: true,
					content: 'x',
					path: 'notes/a.txt',
				}),
			/Applying writes is denied/u,
		);
		await assert.rejects(
			() => runner.call('run_command', { command: 'npm test' }),
			/Command is denied/u,
		);
		await assert.rejects(
			() => runner.call('fetch_url', { url: 'https://example.com' }),
			/Network access is denied/u,
		);
	});

	it('keeps built-in tools working while exposing MCP-style providers', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tools-mcp-'));
		await writeFile(join(cwd, 'a.txt'), 'alpha', 'utf8');
		const runner = new ToolRunner(cwd, {
			mcpProviders: [
				{
					callTool(name, input) {
						return { name, text: input.text.toUpperCase() };
					},
					listTools() {
						return [
							{
								description: 'Uppercase text',
								name: 'uppercase',
							},
						];
					},
					name: 'fake',
				},
			],
			maxCalls: 4,
		});

		assert.equal(await runner.call('read_file', { path: 'a.txt' }), 'alpha');
		assert.deepEqual(
			(await runner.call('list_mcp_tools')).map((tool) => tool.toolName),
			['mcp:fake:uppercase'],
		);
		assert.deepEqual(
			await runner.call('mcp:fake:uppercase', { text: 'hello' }),
			{
				name: 'uppercase',
				text: 'HELLO',
			},
		);
	});
});
