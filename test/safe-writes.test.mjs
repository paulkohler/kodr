import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	jailedPath,
	prepareWrites,
	SafeWriteError,
} from '../src/safe-writes.mjs';

describe('safe writes', () => {
	it('rejects path escapes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-'));

		await assert.rejects(() => jailedPath(cwd, '/tmp/outside'), SafeWriteError);
		await assert.rejects(() => jailedPath(cwd, '../outside'), SafeWriteError);
		await assert.rejects(
			() => jailedPath(cwd, 'a/../../outside'),
			SafeWriteError,
		);
	});

	it('rejects symlink parent escapes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-link-'));
		const outside = await mkdtemp(join(tmpdir(), 'koder-outside-'));
		await symlink(outside, join(cwd, 'linked'));

		await assert.rejects(
			() => jailedPath(cwd, 'linked/file.txt'),
			/Symlink parent/u,
		);
	});

	it('supports dry-run diffs without modifying files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-dry-'));
		await writeFile(join(cwd, 'README.md'), 'old\n', 'utf8');

		const result = await prepareWrites(
			cwd,
			[
				{
					content: 'new\n',
					path: 'README.md',
				},
			],
			{ apply: false },
		);

		assert.equal(result.applied, false);
		assert.match(result.writes[0].diff, /-old/u);
		assert.match(result.writes[0].diff, /\+new/u);
		assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'old\n');
	});

	it('applies writes and creates timestamped backups', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-apply-'));
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'app.js'), 'old', 'utf8');

		const result = await prepareWrites(
			cwd,
			[
				{
					content: 'new',
					path: 'src/app.js',
				},
			],
			{
				apply: true,
				timestamp: 'fixed-time',
			},
		);

		assert.equal(result.applied, true);
		assert.equal(await readFile(join(cwd, 'src', 'app.js'), 'utf8'), 'new');
		assert.equal(
			await readFile(
				join(cwd, '.koder', 'backups', 'fixed-time', 'src', 'app.js'),
				'utf8',
			),
			'old',
		);
	});
});
