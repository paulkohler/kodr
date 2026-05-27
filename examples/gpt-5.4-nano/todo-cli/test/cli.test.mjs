import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

const execFileAsync = promisify(execFile);

describe('todo-cli', () => {
	it('supports add/list/done/delete with --file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'todo-cli-'));
		const filePath = join(dir, 'todos.json');

		const add = await execFileAsync(
			'node',
			['src/cli.mjs', '--file', filePath, 'add', 'Hello'],
			{
				cwd: new URL('..', import.meta.url).pathname,
			},
		);
		assert.equal(add.code, undefined);
		assert.match(add.stdout, /Added /u);

		const list1 = await execFileAsync(
			'node',
			['src/cli.mjs', '--file', filePath, 'list'],
			{
				cwd: new URL('..', import.meta.url).pathname,
			},
		);
		assert.match(list1.stdout, /\[ \] /u);
		assert.match(list1.stdout, /Hello/iu);

		// Extract id from list output
		const match = list1.stdout.match(/\[ \]\s+(\S+)\s+Hello/iu);
		assert.ok(match);
		const id = match[1];

		await execFileAsync(
			'node',
			['src/cli.mjs', '--file', filePath, 'done', id],
			{
				cwd: new URL('..', import.meta.url).pathname,
			},
		);

		const list2 = await execFileAsync(
			'node',
			['src/cli.mjs', '--file', filePath, 'list'],
			{
				cwd: new URL('..', import.meta.url).pathname,
			},
		);
		assert.match(list2.stdout, /\[x\]\s+\S+/iu);

		await execFileAsync(
			'node',
			['src/cli.mjs', '--file', filePath, 'delete', id],
			{
				cwd: new URL('..', import.meta.url).pathname,
			},
		);

		const list3 = await execFileAsync(
			'node',
			['src/cli.mjs', '--file', filePath, 'list'],
			{
				cwd: new URL('..', import.meta.url).pathname,
			},
		);
		assert.equal(list3.stdout.trim(), '');

		await rm(dir, { force: true, recursive: true });
	});

	it('prints usage and exits non-zero when no command is provided', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'todo-cli-'));
		const filePath = join(dir, 'todos.json');

		let stdout = '';
		let exitCode = 0;
		try {
			await execFileAsync('node', ['src/cli.mjs', '--file', filePath], {
				cwd: new URL('..', import.meta.url).pathname,
			});
		} catch (error) {
			stdout = error.stdout;
			exitCode = error.code;
		}
		assert.ok(stdout.includes('Usage'));
		assert.notEqual(exitCode, 0);

		await rm(dir, { force: true, recursive: true });
	});
});
