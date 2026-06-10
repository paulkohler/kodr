import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { contentHash } from '../src/safe-writes.mjs';
import { undoLastApply } from '../src/undo.mjs';

describe('undoLastApply', () => {
	it('reports when no applied run exists', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-undo-test-'));
		const result = await undoLastApply(cwd);
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'no-applied-run');
	});

	it('restores modified files and deletes created files from the last applied run', async () => {
		const cwd = await makeWorkspace();
		await writeFile(join(cwd, 'existing.txt'), 'applied content\n');
		await writeFile(join(cwd, 'created.txt'), 'new file\n');
		await writeBackup(cwd, 'run-1', 'existing.txt', 'original content\n');
		await writeRun(cwd, '2026-06-11T10-00-00.000Z', {
			applied: true,
			writes: [
				appliedWrite(
					cwd,
					'run-1',
					'existing.txt',
					'applied content\n',
					'modify',
				),
				{
					backupPath: '',
					hash: contentHash('new file\n'),
					path: 'created.txt',
					status: 'create',
				},
			],
		});

		const result = await undoLastApply(cwd);

		assert.equal(result.ok, true);
		assert.equal(
			await readFile(join(cwd, 'existing.txt'), 'utf8'),
			'original content\n',
		);
		assert.equal(await exists(join(cwd, 'created.txt')), false);
		assert.deepEqual(
			result.files.map((file) => `${file.action}:${file.path}`).sort(),
			['delete:created.txt', 'restore:existing.txt'],
		);

		const record = JSON.parse(
			await readFile(
				join(cwd, '.kodr', 'runs', '2026-06-11T10-00-00.000Z', 'undo.json'),
				'utf8',
			),
		);
		assert.equal(record.ok, true);

		const again = await undoLastApply(cwd);
		assert.equal(again.ok, false);
		assert.equal(again.reason, 'already-undone');
	});

	it('refuses with conflicts when applied files were edited afterwards', async () => {
		const cwd = await makeWorkspace();
		await writeFile(join(cwd, 'a.txt'), 'edited after apply\n');
		await writeFile(join(cwd, 'b.txt'), 'applied b\n');
		await writeBackup(cwd, 'run-1', 'a.txt', 'original a\n');
		await writeBackup(cwd, 'run-1', 'b.txt', 'original b\n');
		await writeRun(cwd, '2026-06-11T10-00-00.000Z', {
			applied: true,
			writes: [
				appliedWrite(cwd, 'run-1', 'a.txt', 'applied a\n', 'modify'),
				appliedWrite(cwd, 'run-1', 'b.txt', 'applied b\n', 'modify'),
			],
		});

		const result = await undoLastApply(cwd);

		assert.equal(result.ok, false);
		assert.equal(result.reason, 'conflict');
		assert.equal(result.conflicts.length, 1);
		assert.equal(result.conflicts[0].path, 'a.txt');
		// Nothing is reverted on conflict, including the clean file.
		assert.equal(await readFile(join(cwd, 'b.txt'), 'utf8'), 'applied b\n');
		assert.equal(
			await exists(
				join(cwd, '.kodr', 'runs', '2026-06-11T10-00-00.000Z', 'undo.json'),
			),
			false,
		);
	});

	it('refuses runs that predate hash recording', async () => {
		const cwd = await makeWorkspace();
		await writeFile(join(cwd, 'a.txt'), 'applied a\n');
		await writeBackup(cwd, 'run-1', 'a.txt', 'original a\n');
		await writeRun(cwd, '2026-06-11T10-00-00.000Z', {
			applied: true,
			writes: [
				{
					backupPath: join(cwd, '.kodr', 'backups', 'run-1', 'a.txt'),
					path: 'a.txt',
					status: 'modify',
				},
			],
		});

		const result = await undoLastApply(cwd);
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'conflict');
		assert.match(result.conflicts[0].reason, /No applied-content hash/u);
	});

	it('treats files deleted after apply and missing backups as conflicts', async () => {
		const cwd = await makeWorkspace();
		await writeFile(join(cwd, 'kept.txt'), 'applied kept\n');
		await writeRun(cwd, '2026-06-11T10-00-00.000Z', {
			applied: true,
			writes: [
				{
					backupPath: join(cwd, '.kodr', 'backups', 'run-1', 'gone.txt'),
					hash: contentHash('applied gone\n'),
					path: 'gone.txt',
					status: 'modify',
				},
				{
					backupPath: join(cwd, '.kodr', 'backups', 'run-1', 'kept.txt'),
					hash: contentHash('applied kept\n'),
					path: 'kept.txt',
					status: 'modify',
				},
			],
		});

		const result = await undoLastApply(cwd);
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'conflict');
		const reasons = Object.fromEntries(
			result.conflicts.map((conflict) => [conflict.path, conflict.reason]),
		);
		assert.match(reasons['gone.txt'], /no longer exists/u);
		assert.match(reasons['kept.txt'], /Backup file is missing/u);
	});

	it('targets the newest applied run and skips dry-runs', async () => {
		const cwd = await makeWorkspace();
		await writeFile(join(cwd, 'old.txt'), 'applied old\n');
		await writeFile(join(cwd, 'new.txt'), 'applied new\n');
		await writeBackup(cwd, 'run-1', 'old.txt', 'original old\n');
		await writeBackup(cwd, 'run-2', 'new.txt', 'original new\n');
		await writeRun(cwd, '2026-06-11T09-00-00.000Z', {
			applied: true,
			writes: [
				appliedWrite(cwd, 'run-1', 'old.txt', 'applied old\n', 'modify'),
			],
		});
		await writeRun(cwd, '2026-06-11T10-00-00.000Z', {
			applied: true,
			writes: [
				appliedWrite(cwd, 'run-2', 'new.txt', 'applied new\n', 'modify'),
			],
		});
		await writeRun(cwd, '2026-06-11T11-00-00.000Z', {
			applied: false,
			writes: [appliedWrite(cwd, 'run-3', 'new.txt', 'dry-run\n', 'modify')],
		});

		const result = await undoLastApply(cwd);

		assert.equal(result.ok, true);
		assert.match(result.runDir, /2026-06-11T10-00-00\.000Z/u);
		assert.equal(
			await readFile(join(cwd, 'new.txt'), 'utf8'),
			'original new\n',
		);
		assert.equal(await readFile(join(cwd, 'old.txt'), 'utf8'), 'applied old\n');
	});

	it('collapses duplicate patch records for the same path into one restore', async () => {
		const cwd = await makeWorkspace();
		await writeFile(join(cwd, 'a.txt'), 'final patched\n');
		await writeBackup(cwd, 'run-1', 'a.txt', 'original a\n');
		const write = appliedWrite(
			cwd,
			'run-1',
			'a.txt',
			'final patched\n',
			'patch',
		);
		await writeRun(cwd, '2026-06-11T10-00-00.000Z', {
			applied: true,
			writes: [write, { ...write }],
		});

		const result = await undoLastApply(cwd);
		assert.equal(result.ok, true);
		assert.equal(result.files.length, 1);
		assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'original a\n');
	});
});

async function makeWorkspace() {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-undo-test-'));
	await mkdir(join(cwd, '.kodr', 'runs'), { recursive: true });
	return cwd;
}

async function writeRun(cwd, name, writeResult) {
	const runDir = join(cwd, '.kodr', 'runs', name);
	await mkdir(runDir, { recursive: true });
	await writeFile(
		join(runDir, 'writes.json'),
		JSON.stringify(writeResult, null, 2),
	);
}

async function writeBackup(cwd, runStamp, path, content) {
	const backupPath = join(cwd, '.kodr', 'backups', runStamp, path);
	await mkdir(dirname(backupPath), { recursive: true });
	await writeFile(backupPath, content);
}

function appliedWrite(cwd, runStamp, path, appliedContent, status) {
	return {
		backupPath: join(cwd, '.kodr', 'backups', runStamp, path),
		hash: contentHash(appliedContent),
		path,
		status,
	};
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
