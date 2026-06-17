// commands/hook.mjs — kodr hook: manage kodr-generated git hooks.
//
// Phase 174: kodr hook install writes a .git/hooks/pre-commit that runs
// `kodr check --changed --strict`, giving a fast, git-aware pre-commit gate
// without external tooling (husky, lint-staged, etc.).

import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runGit } from '../git-workspace.mjs';

const HOOK_HEADER = '# installed by kodr hook install';

const PRE_COMMIT_CONTENT = `#!/bin/sh
${HOOK_HEADER}
kodr check --changed --strict
`;

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
 * kodr hook install — write a pre-commit hook that runs kodr check --changed --strict.
 * Idempotent: re-installing over a previously installed hook replaces it.
 * Refuses to overwrite a hook not installed by kodr (use --force to override).
 *
 * @param {object} options  Parsed CLI options ({ force }).
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

	const hookPath = join(hooksDir, 'pre-commit');

	// Check whether a non-kodr hook already exists
	let existingContent = null;
	try {
		existingContent = await readFile(hookPath, 'utf8');
	} catch {
		// File doesn't exist — proceed to create it
	}

	if (existingContent !== null) {
		const isKodrHook = existingContent.includes(HOOK_HEADER);
		if (!isKodrHook && !options.force) {
			write(
				`error: ${hookPath} already exists and was not installed by kodr.\n`,
			);
			write('       use --force to overwrite it.\n');
			return { ok: false, command: 'hook' };
		}
	}

	// Ensure the hooks directory exists (some repos may not have it yet)
	await mkdir(hooksDir, { recursive: true });
	await writeFile(hookPath, PRE_COMMIT_CONTENT, 'utf8');
	await chmod(hookPath, 0o755);

	write(`installed pre-commit hook: ${hookPath}\n`);
	write('  runs: kodr check --changed --strict\n');
	write('  remove with: rm ' + hookPath + '\n');

	return { ok: true, command: 'hook', hookPath };
}

/**
 * kodr hook — dispatch to sub-commands (install, ...).
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
	io.stdout.write(`error: unknown hook sub-command: ${sub || '(none)'}\n`);
	io.stdout.write('  available: install\n');
	return { ok: false, command: 'hook' };
}
