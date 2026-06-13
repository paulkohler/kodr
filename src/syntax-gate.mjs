// syntax-gate.mjs — Node.js --check syntax gate for written JS files.
//
// Runs `node --check <path>` on each applied .mjs/.cjs/.js file and produces
// a syntaxResult = { ok, checked, failures: [{path, message}] }.
//
// Design rules:
// - Always-on for JS writes (no LSP required).
// - Language-scoped: only .mjs/.cjs/.js; all other extensions are skipped.
// - Uses the already-allowlisted `node --check <file>` command.
// - Parses stderr to extract a clean human-readable message.
// - Zero runtime dependencies; Node.js 24 built-ins only.

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';

const JS_EXTENSIONS = new Set(['.mjs', '.cjs', '.js']);

/**
 * Returns true when path has a JS extension we can check.
 * @param {string} path  Workspace-relative or absolute path.
 */
export function isJsFile(path) {
	return JS_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * Parse the stderr output from `node --check <file>` into a single-line
 * human-readable message.
 *
 * node --check stderr format:
 *   file:///abs/path/to/file.mjs:3
 *   return 1;
 *          ^
 *   SyntaxError: Illegal return statement
 *       at ...
 *
 * We want just: "Illegal return statement" (the SyntaxError message line).
 *
 * @param {string} stderr
 * @returns {string}
 */
export function parseSyntaxErrorMessage(stderr) {
	const lines = stderr.split('\n');
	for (const line of lines) {
		const m = /SyntaxError:\s*(.+)/u.exec(line.trim());
		if (m) {
			return m[1].trim();
		}
	}
	// Fallback: return the first non-empty line
	const first = lines.find((l) => l.trim().length > 0);
	return first ? first.trim() : 'syntax error';
}

/**
 * Run `node --check` on a single absolute file path.
 * Returns { ok: true } on success, { ok: false, message } on failure.
 *
 * @param {string} absolutePath
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
async function checkOneFile(absolutePath) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['--check', absolutePath], {
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		const stderrChunks = [];
		child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ ok: true });
			} else {
				const stderr = Buffer.concat(stderrChunks).toString('utf8');
				resolve({ ok: false, message: parseSyntaxErrorMessage(stderr) });
			}
		});
		child.on('error', (err) => {
			resolve({ ok: false, message: err.message });
		});
	});
}

/**
 * Run node --check on each JS file in `paths` (workspace-relative).
 * Skips non-JS extensions and paths that cannot be read.
 *
 * @param {string} cwd  Workspace root (absolute path).
 * @param {string[]} paths  Workspace-relative file paths from writeResult.writes.
 * @returns {Promise<{ok: boolean, checked: number, failures: Array<{path: string, message: string}>}>}
 */
export async function runSyntaxGate(cwd, paths) {
	const failures = [];
	let checked = 0;

	for (const p of paths) {
		// Safety: reject absolute paths and traversal attempts
		if (isAbsolute(p) || p.includes('..')) {
			continue;
		}
		if (!isJsFile(p)) {
			continue;
		}
		const abs = join(cwd, p);
		// Skip if file is not readable (e.g. deleted in dry-run)
		try {
			await access(abs);
		} catch {
			continue;
		}
		checked += 1;
		const result = await checkOneFile(abs);
		if (!result.ok) {
			failures.push({ path: p, message: result.message });
		}
	}

	return {
		checked,
		failures,
		ok: failures.length === 0,
	};
}

/**
 * Convenience gate: run the syntax check only when a write was applied and
 * there are JS files in the write list.
 *
 * @param {string} cwd  Workspace root (absolute path).
 * @param {object} writeResult  { applied: boolean, writes: [{ path }] }
 * @returns {Promise<{ok: boolean, checked: number, failures: Array<{path,message}>}|null>}
 *   null when no JS files were written (C3: omit syntaxCheck from summary).
 */
export async function runSyntaxGateIfNeeded(cwd, writeResult) {
	if (!writeResult?.applied) return null;
	const paths = Array.isArray(writeResult.writes)
		? writeResult.writes.map((w) => w.path)
		: [];
	const jsPaths = paths.filter(isJsFile);
	if (jsPaths.length === 0) return null;
	return runSyntaxGate(cwd, paths);
}

/**
 * Build a failed-verification-style result from a syntaxResult so it can be
 * fed directly to the heal loop as `testResult`.
 *
 * Shape matches the runVerification() return so healing.mjs is unaware of the
 * difference.
 *
 * @param {object} syntaxResult  Result of runSyntaxGate/runSyntaxGateIfNeeded.
 * @returns {{ ok: false, command: string, exitCode: number, stdout: string, stderr: string, timedOut: false }}
 */
export function syntaxResultToVerification(syntaxResult) {
	const failLines = syntaxResult.failures
		.map((f) => `SyntaxError in ${f.path}: ${f.message}`)
		.join('\n');
	return {
		command: 'node --check',
		durationMs: 0,
		exitCode: 1,
		finishedAt: new Date().toISOString(),
		ok: false,
		startedAt: new Date().toISOString(),
		stderr: failLines,
		stdout: '',
		timedOut: false,
	};
}
