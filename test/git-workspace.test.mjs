import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import {
	GIT_COMMAND_ALLOWLIST,
	GitCommandError,
	buildCommitMessage,
	commitAppliedWrites,
	gitTreeState,
	parseGitArgs,
	runGit,
} from '../src/git-workspace.mjs';

const execFileAsync = promisify(execFile);

describe('parseGitArgs', () => {
	it('allows only the allowlisted subcommands', () => {
		for (const subcommand of GIT_COMMAND_ALLOWLIST) {
			assert.deepEqual(parseGitArgs([subcommand]), [subcommand]);
		}
		for (const denied of [
			'push',
			'pull',
			'rebase',
			'branch',
			'config',
			'stash',
			'clean',
			'reset',
		]) {
			assert.throws(() => parseGitArgs([denied]), GitCommandError);
		}
	});

	it('rejects options before the subcommand', () => {
		assert.throws(
			() => parseGitArgs(['-c', 'core.fsmonitor=/tmp/x', 'status']),
			/subcommand must come first/u,
		);
		assert.throws(() => parseGitArgs(['--exec-path=/tmp', 'status']));
	});

	it('rejects empty and non-string arguments', () => {
		assert.throws(() => parseGitArgs([]), GitCommandError);
		assert.throws(() => parseGitArgs(['status', '']), GitCommandError);
		assert.throws(() => parseGitArgs(['status', 42]), GitCommandError);
		assert.throws(() => parseGitArgs('status'), GitCommandError);
	});
});

describe('runGit', () => {
	it('never invokes the runner for non-allowlisted commands', async () => {
		let called = false;
		await assert.rejects(
			() =>
				runGit(process.cwd(), ['push', 'origin', 'main'], {
					runner: async () => {
						called = true;
						return { exitCode: 0, stderr: '', stdout: '' };
					},
				}),
			GitCommandError,
		);
		assert.equal(called, false);
	});

	it('passes parsed args to the injected runner', async () => {
		const calls = [];
		const result = await runGit('/work', ['status', '--porcelain'], {
			runner: async (cwd, args) => {
				calls.push({ args, cwd });
				return { exitCode: 0, stderr: '', stdout: '' };
			},
		});
		assert.equal(result.exitCode, 0);
		assert.deepEqual(calls, [
			{ args: ['status', '--porcelain'], cwd: '/work' },
		]);
	});
});

describe('gitTreeState', () => {
	it('reports not-a-repo when rev-parse fails', async () => {
		const state = await gitTreeState('/work', {
			runner: async () => ({ exitCode: 128, stderr: 'fatal', stdout: '' }),
		});
		assert.equal(state.state, 'not-a-repo');
	});

	it('reports clean and dirty from porcelain output', async () => {
		const clean = await gitTreeState('/work', {
			runner: async (cwd, args) =>
				args[0] === 'rev-parse'
					? { exitCode: 0, stderr: '', stdout: 'true\n' }
					: { exitCode: 0, stderr: '', stdout: '' },
		});
		assert.equal(clean.state, 'clean');

		const dirty = await gitTreeState('/work', {
			runner: async (cwd, args) =>
				args[0] === 'rev-parse'
					? { exitCode: 0, stderr: '', stdout: 'true\n' }
					: { exitCode: 0, stderr: '', stdout: ' M src/app.mjs\n?? new.txt\n' },
		});
		assert.equal(dirty.state, 'dirty');
		assert.deepEqual(dirty.dirtyFiles, ['src/app.mjs', 'new.txt']);
	});
});

describe('buildCommitMessage', () => {
	it('references the run id and truncates long prompts', () => {
		const message = buildCommitMessage({
			prompt: 'Add a --version flag to the CLI',
			runId: 'run-123',
		});
		assert.match(
			message,
			/^kodr: Add a --version flag to the CLI\n\nrun: run-123$/u,
		);

		const long = buildCommitMessage({ prompt: 'x'.repeat(100), runId: 'r' });
		assert.ok(long.split('\n')[0].length <= 70);
		assert.match(long, /\.\.\.$/mu);
	});
});

describe('commitAppliedWrites', () => {
	it('refuses suspicious paths before any git call', async () => {
		let called = false;
		const runner = async () => {
			called = true;
			return { exitCode: 0, stderr: '', stdout: '' };
		};
		for (const path of ['/etc/passwd', '../escape.txt', '-rf', '']) {
			const result = await commitAppliedWrites('/work', {
				files: [path],
				message: 'kodr: x\n\nrun: r',
				runner,
			});
			assert.equal(result.committed, false);
			assert.match(result.error, /suspicious|No applied files/u);
		}
		assert.equal(called, false);
	});

	it('refuses empty file lists and empty messages', async () => {
		const none = await commitAppliedWrites('/work', {
			files: [],
			message: 'm',
		});
		assert.equal(none.committed, false);
		const blank = await commitAppliedWrites('/work', {
			files: ['a.txt'],
			message: '  ',
			runner: async () => ({ exitCode: 0, stderr: '', stdout: '' }),
		});
		assert.equal(blank.committed, false);
	});

	it('stages and commits only the given files with the message', async () => {
		const calls = [];
		const result = await commitAppliedWrites('/work', {
			files: ['src/a.mjs', 'test/a.test.mjs', 'src/a.mjs'],
			message: 'kodr: task\n\nrun: run-1',
			runner: async (cwd, args) => {
				calls.push(args);
				return {
					exitCode: 0,
					stderr: '',
					stdout: args[0] === 'rev-parse' ? 'abc123\n' : '',
				};
			},
		});

		assert.equal(result.committed, true);
		assert.equal(result.sha, 'abc123');
		assert.deepEqual(calls[0], ['add', '--', 'src/a.mjs', 'test/a.test.mjs']);
		assert.deepEqual(calls[1], [
			'commit',
			'-m',
			'kodr: task\n\nrun: run-1',
			'--',
			'src/a.mjs',
			'test/a.test.mjs',
		]);
		assert.deepEqual(calls[2], ['rev-parse', 'HEAD']);
	});

	it('reports git failures honestly without throwing', async () => {
		const result = await commitAppliedWrites('/work', {
			files: ['a.txt'],
			message: 'm',
			runner: async (cwd, args) =>
				args[0] === 'commit'
					? { exitCode: 1, stderr: 'nothing to commit', stdout: '' }
					: { exitCode: 0, stderr: '', stdout: '' },
		});
		assert.equal(result.committed, false);
		assert.match(result.error, /git commit failed/u);
	});

	it('commits only applied files in a real git repository', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-git-test-'));
		await execFileAsync('git', ['init', '-q'], { cwd });
		await execFileAsync('git', ['config', 'user.email', 'kodr@test'], { cwd });
		await execFileAsync('git', ['config', 'user.name', 'kodr test'], { cwd });

		await writeFile(join(cwd, 'applied.txt'), 'applied content\n');
		await writeFile(join(cwd, 'unrelated.txt'), 'should stay untracked\n');

		const before = await gitTreeState(cwd);
		assert.equal(before.state, 'dirty');

		const result = await commitAppliedWrites(cwd, {
			files: ['applied.txt'],
			message: buildCommitMessage({ prompt: 'real git test', runId: 'run-x' }),
		});
		assert.equal(result.committed, true);
		assert.match(result.sha, /^[0-9a-f]{40}$/u);

		const show = await execFileAsync(
			'git',
			['show', '--name-only', '--format=%s', 'HEAD'],
			{ cwd },
		);
		assert.match(show.stdout, /kodr: real git test/u);
		assert.match(show.stdout, /applied\.txt/u);
		assert.doesNotMatch(show.stdout, /unrelated\.txt/u);

		const after = await gitTreeState(cwd);
		assert.equal(after.state, 'dirty');
		assert.deepEqual(after.dirtyFiles, ['unrelated.txt']);
	});
});
