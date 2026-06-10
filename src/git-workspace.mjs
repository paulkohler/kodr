import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

export class GitCommandError extends Error {
	constructor(message) {
		super(message);
		this.name = 'GitCommandError';
	}
}

// The only git subcommands Kodr may ever execute. No push, pull, rebase,
// branch, stash, or config — and no arbitrary git. Everything else must fail
// before a process is spawned.
export const GIT_COMMAND_ALLOWLIST = new Set([
	'add',
	'checkout',
	'commit',
	'diff',
	'rev-parse',
	'status',
]);

const DEFAULT_GIT_TIMEOUT_MS = 30000;

export function parseGitArgs(args) {
	if (!Array.isArray(args) || args.length === 0) {
		throw new GitCommandError('Git command requires arguments');
	}
	for (const arg of args) {
		if (typeof arg !== 'string' || arg.length === 0) {
			throw new GitCommandError('Git arguments must be non-empty strings');
		}
	}
	// The subcommand must come first: `git -c core.fsmonitor=...` and similar
	// pre-subcommand options can change git behavior and are refused.
	const subcommand = args[0];
	if (subcommand.startsWith('-')) {
		throw new GitCommandError(
			`Git subcommand must come first, got option: ${subcommand}`,
		);
	}
	if (!GIT_COMMAND_ALLOWLIST.has(subcommand)) {
		throw new GitCommandError(`Git command is not allowlisted: ${subcommand}`);
	}
	return [...args];
}

export async function runGit(cwd, args, options = {}) {
	const parsed = parseGitArgs(args);
	const runner = options.runner || spawnGit;
	const timeoutMs = options.timeoutMs || DEFAULT_GIT_TIMEOUT_MS;
	return runner(cwd, parsed, timeoutMs);
}

// Returns { state: 'clean' | 'dirty' | 'not-a-repo', dirtyFiles }.
export async function gitTreeState(cwd, options = {}) {
	const inside = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'], {
		...options,
	}).catch(() => null);
	if (!inside || inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
		return { dirtyFiles: [], state: 'not-a-repo' };
	}

	const status = await runGit(cwd, ['status', '--porcelain'], { ...options });
	if (status.exitCode !== 0) {
		return { dirtyFiles: [], state: 'not-a-repo' };
	}
	const dirtyFiles = status.stdout
		.split('\n')
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
	return {
		dirtyFiles,
		state: dirtyFiles.length === 0 ? 'clean' : 'dirty',
	};
}

export function buildCommitMessage({ prompt = '', runId = '' }) {
	const subjectSource = prompt.split('\n')[0].trim() || 'apply run writes';
	const subject =
		subjectSource.length > 64
			? `${subjectSource.slice(0, 61)}...`
			: subjectSource;
	return `kodr: ${subject}\n\nrun: ${runId}`;
}

// Stages and commits exactly the given workspace-relative files. Refuses
// suspicious paths before any git process runs. Returns an honest result
// object instead of throwing on git failures so callers can artifact it.
export async function commitAppliedWrites(cwd, options = {}) {
	const files = [...new Set(options.files || [])];
	const message = options.message || '';
	const runnerOptions = {
		runner: options.runner,
		timeoutMs: options.timeoutMs,
	};

	if (files.length === 0) {
		return { committed: false, error: 'No applied files to commit', files };
	}
	if (!message.trim()) {
		return {
			committed: false,
			error: 'Commit message must not be empty',
			files,
		};
	}
	for (const file of files) {
		if (
			typeof file !== 'string' ||
			file.length === 0 ||
			isAbsolute(file) ||
			file.split(/[\\/]+/u).includes('..') ||
			file.startsWith('-')
		) {
			return {
				committed: false,
				error: `Refusing to commit suspicious path: ${file}`,
				files,
			};
		}
	}

	const add = await runGit(cwd, ['add', '--', ...files], runnerOptions);
	if (add.exitCode !== 0) {
		return {
			committed: false,
			error: `git add failed: ${(add.stderr || add.stdout).trim()}`,
			files,
		};
	}

	const commit = await runGit(
		cwd,
		['commit', '-m', message, '--', ...files],
		runnerOptions,
	);
	if (commit.exitCode !== 0) {
		return {
			committed: false,
			error: `git commit failed: ${(commit.stderr || commit.stdout).trim()}`,
			files,
		};
	}

	const head = await runGit(cwd, ['rev-parse', 'HEAD'], runnerOptions);
	return {
		committed: true,
		files,
		message,
		sha: head.exitCode === 0 ? head.stdout.trim() : '',
	};
}

function spawnGit(cwd, args, timeoutMs) {
	return new Promise((resolve) => {
		const child = spawn('git', args, {
			cwd,
			shell: false,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (result) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(result);
			}
		};
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish({
				exitCode: null,
				stderr: 'git timed out',
				stdout,
				timedOut: true,
			});
		}, timeoutMs);
		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', (error) => {
			finish({
				exitCode: null,
				stderr: error.message,
				stdout,
				timedOut: false,
			});
		});
		child.on('close', (exitCode) => {
			finish({ exitCode, stderr, stdout, timedOut: false });
		});
	});
}
