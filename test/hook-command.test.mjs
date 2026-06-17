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
	runHookStatus,
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

describe('runHookStatus', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-hook-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns error when not in a git repo', async () => {
		const io = makeIo(cwd);
		const result = await runHookStatus({}, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /not inside a git repository/u);
	});

	it('reports not installed when no hook file exists', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookStatus({}, io);
		assert.equal(result.ok, true);
		assert.equal(result.hookStatus, 'none');
		assert.match(io._output(), /not installed/u);
	});

	it('reports kodr-owned hook', async () => {
		await initGitRepo(cwd);
		await runHookInstall({}, makeIo(cwd));
		const io = makeIo(cwd);
		const result = await runHookStatus({}, io);
		assert.equal(result.ok, true);
		assert.equal(result.hookStatus, 'kodr');
		assert.match(io._output(), /installed by kodr/u);
	});

	it('reports foreign hook', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "custom"\n');
		const io = makeIo(cwd);
		const result = await runHookStatus({}, io);
		assert.equal(result.ok, true);
		assert.equal(result.hookStatus, 'foreign');
		assert.match(io._output(), /foreign/u);
	});

	it('reports hookStatuses for both hooks', async () => {
		await initGitRepo(cwd);
		await runHookInstall({}, makeIo(cwd));
		await runHookInstall({ prePush: true }, makeIo(cwd));
		const io = makeIo(cwd);
		const result = await runHookStatus({}, io);
		assert.equal(result.ok, true);
		assert.equal(result.hookStatuses['pre-commit'], 'kodr');
		assert.equal(result.hookStatuses['pre-push'], 'kodr');
	});

	// Phase 197: --json flag
	it('--json emits structured JSON with hookStatuses', async () => {
		await initGitRepo(cwd);
		await runHookInstall({}, makeIo(cwd));
		const io = makeIo(cwd);
		const result = await runHookStatus({ json: true }, io);
		assert.equal(result.ok, true);
		const parsed = JSON.parse(io._output());
		assert.equal(parsed.ok, true);
		assert.equal(parsed.command, 'hook');
		assert.equal(parsed.hookStatuses['pre-commit'], 'kodr');
		assert.equal(parsed.hookStatuses['pre-push'], 'none');
	});

	it('--json emits valid JSON even when no hooks installed', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		await runHookStatus({ json: true }, io);
		const parsed = JSON.parse(io._output());
		assert.equal(parsed.hookStatus, 'none');
		assert.ok(
			!io._output().includes('not installed'),
			'--json must not mix in text',
		);
	});
});

describe('runHookInstall --pre-push (Phase 191)', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-hook-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('installs the pre-push hook', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookInstall({ prePush: true }, io);
		assert.equal(result.ok, true);
		assert.ok(result.hookPath?.endsWith('pre-push'));
		const content = await readFile(result.hookPath, 'utf8');
		assert.match(content, /kodr check --strict/u);
	});

	it('pre-push hook is executable', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookInstall({ prePush: true }, io);
		assert.equal(result.ok, true);
		const { stat } = await import('node:fs/promises');
		const s = await stat(result.hookPath);
		// eslint-disable-next-line no-bitwise
		assert.ok((s.mode & 0o111) !== 0, 'pre-push hook should be executable');
	});

	it('refuses to overwrite a foreign pre-push hook without --force', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-push'), '#!/bin/sh\necho "push"\n');
		const io = makeIo(cwd);
		const result = await runHookInstall({ prePush: true }, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /use --force/u);
	});

	it('uses config-overridden pre-commit command when hooks.preCommit is set', async () => {
		await initGitRepo(cwd);
		const kodrDir = join(cwd, '.kodr');
		await mkdir(kodrDir, { recursive: true });
		await writeFile(
			join(kodrDir, 'config.json'),
			JSON.stringify({
				hooks: { preCommit: 'kodr check --changed --strict --deep' },
			}),
		);
		const io = makeIo(cwd);
		const result = await runHookInstall({}, io);
		assert.equal(result.ok, true);
		const content = await readFile(result.hookPath, 'utf8');
		assert.match(content, /kodr check --changed --strict --deep/u);
	});

	it('uses config-overridden pre-push command when hooks.prePush is set', async () => {
		await initGitRepo(cwd);
		const kodrDir = join(cwd, '.kodr');
		await mkdir(kodrDir, { recursive: true });
		await writeFile(
			join(kodrDir, 'config.json'),
			JSON.stringify({ hooks: { prePush: 'kodr check --strict --deep' } }),
		);
		const io = makeIo(cwd);
		const result = await runHookInstall({ prePush: true }, io);
		assert.equal(result.ok, true);
		const content = await readFile(result.hookPath, 'utf8');
		assert.match(content, /kodr check --strict --deep/u);
	});
});

describe('runHookUninstall --pre-push (Phase 191)', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-hook-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('removes a kodr-installed pre-push hook', async () => {
		await initGitRepo(cwd);
		const io1 = makeIo(cwd);
		const installed = await runHookInstall({ prePush: true }, io1);
		assert.equal(installed.ok, true);

		const io2 = makeIo(cwd);
		const result = await runHookUninstall({ prePush: true }, io2);
		assert.equal(result.ok, true);
		assert.match(io2._output(), /removed pre-push hook/u);

		await assert.rejects(() => readFile(installed.hookPath, 'utf8'), {
			code: 'ENOENT',
		});
	});

	it('returns error when pre-push hook does not exist', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHookUninstall({ prePush: true }, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /does not exist/u);
	});

	it('refuses to remove a foreign pre-push hook without --force', async () => {
		await initGitRepo(cwd);
		const hooksDir = join(cwd, '.git', 'hooks');
		await mkdir(hooksDir, { recursive: true });
		await writeFile(join(hooksDir, 'pre-push'), '#!/bin/sh\necho "push"\n');
		const io = makeIo(cwd);
		const result = await runHookUninstall({ prePush: true }, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /use --force/u);
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

	it('dispatches to status sub-command', async () => {
		await initGitRepo(cwd);
		const io = makeIo(cwd);
		const result = await runHook({ hookSubcommand: 'status' }, io);
		assert.equal(result.ok, true);
		assert.equal(result.hookStatus, 'none');
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
