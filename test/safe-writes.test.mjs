import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	jailedPath,
	prepareChanges,
	preparePatches,
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

	it('rejects existing symlink file targets', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-link-file-'));
		const outside = await mkdtemp(join(tmpdir(), 'koder-outside-file-'));
		await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
		await symlink(join(outside, 'secret.txt'), join(cwd, 'linked.txt'));

		await assert.rejects(
			() => jailedPath(cwd, 'linked.txt'),
			/Symlink target/u,
		);
		await assert.rejects(
			() =>
				prepareWrites(
					cwd,
					[
						{
							content: 'changed',
							path: 'linked.txt',
						},
					],
					{ apply: true },
				),
			/Symlink target/u,
		);
		assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
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

	it('applies exact patches and creates backups', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-patch-'));
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'app.js'), 'one\ntwo\nthree\n', 'utf8');

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'src/app.js',
					replace: 'TWO\n',
					search: 'two\n',
				},
			],
			{
				apply: true,
				timestamp: 'patch-time',
			},
		);

		assert.equal(result.applied, true);
		assert.equal(result.writes[0].status, 'patch');
		assert.equal(
			await readFile(join(cwd, 'src', 'app.js'), 'utf8'),
			'one\nTWO\nthree\n',
		);
		assert.equal(
			await readFile(
				join(cwd, '.koder', 'backups', 'patch-time', 'src', 'app.js'),
				'utf8',
			),
			'one\ntwo\nthree\n',
		);
	});

	it('rejects stale or ambiguous patches', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-stale-patch-'));
		await writeFile(join(cwd, 'README.md'), 'same\nsame\n', 'utf8');

		await assert.rejects(
			() =>
				preparePatches(cwd, [
					{
						path: 'README.md',
						replace: 'changed',
						search: 'same',
					},
				]),
			/match exactly once/u,
		);
		await assert.rejects(
			() =>
				preparePatches(cwd, [
					{
						path: 'README.md',
						replace: 'changed',
						search: 'missing',
					},
				]),
			/found 0/u,
		);
		assert.equal(
			await readFile(join(cwd, 'README.md'), 'utf8'),
			'same\nsame\n',
		);
	});

	it('does not partially apply a patch batch when a later patch is stale', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-patch-batch-'));
		await writeFile(join(cwd, 'a.txt'), 'alpha\n', 'utf8');
		await writeFile(join(cwd, 'b.txt'), 'beta\n', 'utf8');

		await assert.rejects(
			() =>
				preparePatches(
					cwd,
					[
						{
							path: 'a.txt',
							replace: 'ALPHA\n',
							search: 'alpha\n',
						},
						{
							path: 'b.txt',
							replace: 'BETA\n',
							search: 'missing\n',
						},
					],
					{ apply: true },
				),
			/found 0/u,
		);

		assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'alpha\n');
		assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'beta\n');
	});

	it('composes multiple patches to the same file before writing', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-patch-compose-'));
		await writeFile(join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8');

		await preparePatches(
			cwd,
			[
				{
					path: 'notes.txt',
					replace: 'ALPHA\n',
					search: 'alpha\n',
				},
				{
					path: 'notes.txt',
					replace: 'BETA\n',
					search: 'beta\n',
				},
			],
			{ apply: true },
		);

		assert.equal(
			await readFile(join(cwd, 'notes.txt'), 'utf8'),
			'ALPHA\nBETA\ngamma\n',
		);
	});

	it('normalizes double-escaped patch newlines only when unambiguous', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-escaped-patch-'));
		await writeFile(join(cwd, 'README.md'), 'hello\nworld\n', 'utf8');

		const result = await preparePatches(
			cwd,
			[
				{
					path: 'README.md',
					replace: 'hello\\nthere\\n',
					search: 'hello\\nworld\\n',
				},
			],
			{ apply: true },
		);

		assert.equal(result.writes[0].status, 'patch');
		assert.equal(
			await readFile(join(cwd, 'README.md'), 'utf8'),
			'hello\nthere\n',
		);
	});

	it('matches whitespace-drifted patch searches only when unambiguous', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-fuzzy-patch-'));
		await writeFile(
			join(cwd, 'app.mjs'),
			'export function run() {\n\tconst rows = [];\n}\n',
			'utf8',
		);

		await preparePatches(
			cwd,
			[
				{
					path: 'app.mjs',
					replace:
						"export function run() {\n\tif (typeof input !== 'string') {\n\t\tthrow new TypeError('input');\n\t}\n\n\tconst rows =[];\n",
					search: 'export function run() {\n\tconst rows =[];\n',
				},
			],
			{ apply: true },
		);

		assert.match(
			await readFile(join(cwd, 'app.mjs'), 'utf8'),
			/throw new TypeError/u,
		);
	});

	it('can combine full-file writes and patches', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-safe-changes-'));
		await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

		const result = await prepareChanges(
			cwd,
			{
				files: [
					{
						content: 'created\n',
						path: 'new.txt',
					},
				],
				patches: [
					{
						path: 'README.md',
						replace: 'hello world\n',
						search: 'hello\n',
					},
				],
			},
			{ apply: true },
		);

		assert.equal(result.writes.length, 2);
		assert.equal(await readFile(join(cwd, 'new.txt'), 'utf8'), 'created\n');
		assert.equal(
			await readFile(join(cwd, 'README.md'), 'utf8'),
			'hello world\n',
		);
	});
});
