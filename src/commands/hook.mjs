// commands/hook.mjs — kodr hook: manage kodr-generated git hooks.
//
// Phase 174: kodr hook install writes a .git/hooks/pre-commit that runs
// `kodr check --changed --strict`, giving a fast, git-aware pre-commit gate
// without external tooling (husky, lint-staged, etc.).
//
// Phase 177: kodr hook uninstall removes a kodr-installed pre-commit hook.
// Refuses to remove a hook not installed by kodr (use --force to override).
//
// Phase 191: kodr hook install --pre-push installs a pre-push hook running
// `kodr check --strict`. Both hook commands in `.kodr/config.json`
// `hooks.preCommit` / `hooks.prePush` override the baked-in default command.

import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../git-workspace.mjs';
import { loadProjectConfig } from '../project-config.mjs';

const HOOK_HEADER = '# installed by kodr hook install';

const DEFAULT_PRE_COMMIT_CMD = 'kodr check --changed --strict';
const DEFAULT_PRE_PUSH_CMD = 'kodr check --strict';

function hookScript(cmd) {
	return `#!/bin/sh\n${HOOK_HEADER}\n${cmd}\n`;
}

/**
 * Resolve the absolute path to the .git/hooks directory for the workspace.
 * Uses `git rev-parse --git-dir` so it works from any sub-directory.
 * Returns null when the workspace is not inside a git repository.
 *
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function resolveHooksDir(cwd) {
	let result;
	try {
		result = await runGit(cwd, ['rev-parse', '--git-dir']);
	} catch {
		return null;
	}
	if (result.exitCode !== 0) return null;
	const gitDir = result.stdout.trim();
	// git-dir may be relative (e.g. ".git") or absolute (worktrees).
	const absGitDir = gitDir.startsWith('/') ? gitDir : join(cwd, gitDir);
	return join(absGitDir, 'hooks');
}

/**
 * Load the hooks block from project config, if present.
 * Returns {} when no config exists or no hooks block is set.
 *
 * @param {string} cwd
 * @returns {{ preCommit?: string, prePush?: string }}
 */
function loadHooksConfig(cwd) {
	try {
		const loaded = loadProjectConfig(cwd);
		return loaded?.config?.hooks ?? {};
	} catch {
		return {};
	}
}

/**
 * @param {boolean} isPush
 * @param {{ preCommit?: string, prePush?: string }} hooksConfig
 * @returns {{ hookName: string, cmd: string }}
 */
function resolveHookSpec(isPush, hooksConfig) {
	if (isPush) {
		const cmd = hooksConfig.prePush ?? DEFAULT_PRE_PUSH_CMD;
		return { hookName: 'pre-push', cmd };
	}
	const cmd = hooksConfig.preCommit ?? DEFAULT_PRE_COMMIT_CMD;
	return { hookName: 'pre-commit', cmd };
}

/**
 * Read a hook file and return its content and whether kodr owns it.
 *
 * @param {string} hookPath
 * @returns {Promise<{ content: string|null, isKodr: boolean }>}
 */
async function readHookFile(hookPath) {
	try {
		const content = await readFile(hookPath, 'utf8');
		return { content, isKodr: content.includes(HOOK_HEADER) };
	} catch {
		return { content: null, isKodr: false };
	}
}

/**
 * kodr hook install — write a git hook that runs a kodr check command.
 * Default: pre-commit hook running `kodr check --changed --strict`.
 * With --pre-push: pre-push hook running `kodr check --strict`.
 * Idempotent: re-installing over a previously installed hook replaces it.
 * Refuses to overwrite a hook not installed by kodr (use --force to override).
 *
 * @param {object} options  Parsed CLI options ({ force, prePush }).
 * @param {object} io       { cwd, stdout }
 * @returns {Promise<{ok: boolean, command: string, hookPath?: string}>}
 */
export async function runHookInstall(options, io) {
	const write = (s) => io.stdout.write(s);

	const hooksDir = await resolveHooksDir(io.cwd);
	if (!hooksDir) {
		write('error: not inside a git repository\n');
		return { ok: false, command: 'hook' };
	}

	const hooksConfig = loadHooksConfig(io.cwd);
	const { hookName, cmd } = resolveHookSpec(!!options.prePush, hooksConfig);
	const hookPath = join(hooksDir, hookName);

	const { content: existingContent, isKodr } = await readHookFile(hookPath);

	if (existingContent !== null && !isKodr && !options.force) {
		write(`error: ${hookPath} already exists and was not installed by kodr.\n`);
		write('       use --force to overwrite it.\n');
		return { ok: false, command: 'hook' };
	}

	await mkdir(hooksDir, { recursive: true });
	await writeFile(hookPath, hookScript(cmd), 'utf8');
	await chmod(hookPath, 0o755);

	const result = { ok: true, command: 'hook', hookPath, hookName, cmd };
	if (options.json) {
		write(JSON.stringify(result, null, 2));
		write('\n');
	} else {
		write(`installed ${hookName} hook: ${hookPath}\n`);
		write(`  runs: ${cmd}\n`);
		write(`  remove with: rm ${hookPath}\n`);
	}

	return result;
}

/**
 * kodr hook uninstall — remove a kodr-installed git hook.
 * Default: removes the pre-commit hook.
 * With --pre-push: removes the pre-push hook.
 * Refuses to remove a hook not installed by kodr unless --force is set.
 *
 * @param {object} options  Parsed CLI options ({ force, prePush }).
 * @param {object} io       { cwd, stdout }
 * @returns {Promise<{ok: boolean, command: string, hookPath?: string}>}
 */
export async function runHookUninstall(options, io) {
	const write = (s) => io.stdout.write(s);

	const hooksDir = await resolveHooksDir(io.cwd);
	if (!hooksDir) {
		write('error: not inside a git repository\n');
		return { ok: false, command: 'hook' };
	}

	const hookName = options.prePush ? 'pre-push' : 'pre-commit';
	const hookPath = join(hooksDir, hookName);

	const { content: existingContent, isKodr } = await readHookFile(hookPath);

	if (existingContent === null) {
		write(`error: ${hookPath} does not exist\n`);
		return { ok: false, command: 'hook' };
	}

	if (!isKodr && !options.force) {
		write(`error: ${hookPath} was not installed by kodr.\n`);
		write('       use --force to remove it anyway.\n');
		return { ok: false, command: 'hook' };
	}

	await unlink(hookPath);

	const result = { ok: true, command: 'hook', hookPath, hookName };
	if (options.json) {
		write(JSON.stringify(result, null, 2));
		write('\n');
	} else {
		write(`removed ${hookName} hook: ${hookPath}\n`);
	}

	return result;
}

/**
 * Determine the status string for a hook file.
 *
 * @param {string} hookPath
 * @returns {Promise<'kodr'|'foreign'|'none'>}
 */
async function hookFileStatus(hookPath) {
	const { content, isKodr } = await readHookFile(hookPath);
	if (content === null) return 'none';
	return isKodr ? 'kodr' : 'foreign';
}

/**
 * kodr hook status — report whether git hooks exist and who owns them.
 * Reports both pre-commit and pre-push hooks.
 *
 * @param {object} options  Parsed CLI options.
 * @param {object} io       { cwd, stdout }
 * @returns {Promise<{ok: boolean, command: string, hookStatus?: string, hookPath?: string, hookStatuses?: object}>}
 */
export async function runHookStatus(options, io) {
	const write = (s) => io.stdout.write(s);

	const hooksDir = await resolveHooksDir(io.cwd);
	if (!hooksDir) {
		write('error: not inside a git repository\n');
		return { ok: false, command: 'hook' };
	}

	const preCommitPath = join(hooksDir, 'pre-commit');
	const prePushPath = join(hooksDir, 'pre-push');

	const [preCommitStatus, prePushStatus] = await Promise.all([
		hookFileStatus(preCommitPath),
		hookFileStatus(prePushPath),
	]);

	const renderStatus = (name, path, status) => {
		if (status === 'none') {
			write(`${name} hook: not installed\n`);
		} else if (status === 'kodr') {
			write(`${name} hook: installed by kodr\n`);
			write(`  path: ${path}\n`);
		} else {
			write(`${name} hook: foreign (not installed by kodr)\n`);
			write(`  path: ${path}\n`);
			write(`  use --force with uninstall to remove it\n`);
		}
	};

	const hookStatuses = {
		'pre-commit': preCommitStatus,
		'pre-push': prePushStatus,
	};

	// hookStatus: pre-commit status for backward compatibility.
	// hookPath: only set when pre-commit hook is present.
	const result = {
		ok: true,
		command: 'hook',
		hookStatus: preCommitStatus,
		hookStatuses,
	};
	if (preCommitStatus !== 'none') result.hookPath = preCommitPath;

	if (options.json) {
		write(JSON.stringify(result, null, 2));
		write('\n');
	} else {
		renderStatus('pre-commit', preCommitPath, preCommitStatus);
		renderStatus('pre-push', prePushPath, prePushStatus);
	}

	return result;
}

/**
 * kodr hook — dispatch to sub-commands (install, status, uninstall).
 *
 * @param {object} options
 * @param {object} io
 * @returns {Promise<{ok: boolean, command: string}>}
 */
export async function runHook(options, io) {
	const sub = options.hookSubcommand;
	if (sub === 'install') {
		return runHookInstall(options, io);
	}
	if (sub === 'status') {
		return runHookStatus(options, io);
	}
	if (sub === 'uninstall') {
		return runHookUninstall(options, io);
	}
	io.stdout.write(`error: unknown hook sub-command: ${sub || '(none)'}\n`);
	io.stdout.write('  available: install, status, uninstall\n');
	return { ok: false, command: 'hook' };
}
