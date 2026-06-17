import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
	runHookInstall,
	runHookUninstall,
	runHook,
} from '../src/commands/hook.mjs';

const execFileAsync = promisify(execFile);

function makeIo(cwd) {
	const chunks = [];
	return {
		cwd,
		env: {},
		stdout: { write: (s) => chunks.push(s) },
		_output: () => chunks.join(''),
	};
}

async function initGitRepo(dir) {
	await execFileAsync('git', ['-C', dir, 'init', '-b', 'main']);
	await execFileAsync('git', [
		'-C',
		dir,
		'config',
		'user.email',
		'test@test.com',
	]);
	await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
}

describe('runHookInstall', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-hook-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns error when not in a git repo', async () => {
		const io = makeIo(cwd);
		const result = await runHookInstall({}, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /not inside a git repository/u);
	});

	it('installs the pre-commit hook in a git repo', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookInstall({}, io);
		assert.equal(result.ok, true);
		assert.ok(result.hookPath?.endsWith('pre-commit'));
		const content = await readFile(result.hookPath, 'utf8');
		assert.match(content, /kodr check --changed --strict/u);
	});

	it('hook file is executable after install', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookInstall({}, io);
		assert.equal(result.ok, true);
		// stat the file and check executable bit
		const { stat } = await import('node:fs/promises');
		const s = await stat(result.hookPath);
		// eslint-disable-next-line no-bitwise
		assert.ok((s.mode & 0o111) !== 0, 'hook should be executable');
	});

	it('re-installs over an existing kodr hook without --force', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		await runHookInstall({}, io);
		// Second install should succeed (idempotent)
		const io2 = makeIo(cwd);
		const result2 = await runHookInstall({}, io2);
		assert.equal(result2.ok, true);
	});

	it('refuses to overwrite a foreign hook without --force', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "custom"\n');
		const io = makeIo(cwd);
		const result = await runHookInstall({}, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /use --force/u);
	});

	it('overwrites a foreign hook with --force', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "custom"\n');
		const io = makeIo(cwd);
		const result = await runHookInstall({ force: true }, io);
		assert.equal(result.ok, true);
		const content = await readFile(result.hookPath, 'utf8');
		assert.match(content, /kodr check --changed --strict/u);
	});
});

describe('runHookUninstall', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-hook-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns error when not in a git repo', async () => {
		const io = makeIo(cwd);
		const result = await runHookUninstall({}, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /not inside a git repository/u);
	});

	it('returns error when hook does not exist', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookUninstall({}, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /does not exist/u);
	});

	it('removes a kodr-installed hook', async () => {
		await initGitRepo(cwd);
		const io1 = makeIo(cwd);
		const installed = await runHookInstall({}, io1);
		assert.equal(installed.ok, true);

		const io2 = makeIo(cwd);
		const result = await runHookUninstall({}, io2);
		assert.equal(result.ok, true);
		assert.match(io2._output(), /removed pre-commit hook/u);

		// File should no longer exist
		await assert.rejects(() => readFile(installed.hookPath, 'utf8'), {
			code: 'ENOENT',
		});
	});

	it('refuses to remove a foreign hook without --force', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "custom"\n');
		const io = makeIo(cwd);
		const result = await runHookUninstall({}, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /use --force/u);
	});

	it('removes a foreign hook with --force', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "custom"\n');
		const io = makeIo(cwd);
		const result = await runHookUninstall({ force: true }, io);
		assert.equal(result.ok, true);
	});
});

describe('runHook', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-hook-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('dispatches to install sub-command', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHook({ hookSubcommand: 'install' }, io);
		assert.equal(result.ok, true);
	});

	it('dispatches to uninstall sub-command', async () => {
		await initGitRepo(cwd);
		// Install first, then uninstall
		await runHookInstall({}, makeIo(cwd));
		const io2 = makeIo(cwd);
		const result = await runHook({ hookSubcommand: 'uninstall' }, io2);
		assert.equal(result.ok, true);
	});

	it('returns error for unknown sub-command', async () => {
		const io = makeIo(cwd);
		const result = await runHook({ hookSubcommand: 'unknown' }, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /unknown hook sub-command/u);
	});
});
