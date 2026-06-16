// smoke-check.mjs — executable load probe for a project's JS entry point.
//
// Phase 156. The phase-121 syntax gate runs `node --check`, which only *parses*
// each file — it never links the module graph, so missing-export / CJS-ESM /
// import-time crashes slip through (e.g. `import { sign } from "jsonwebtoken"`,
// where jsonwebtoken is CJS and its named exports are not statically detectable).
// Catching that class of bug requires actually evaluating the module graph.
//
// This probe spawns `node --input-type=module --eval <loader>` and dynamically
// imports the detected entry point. A dynamic import resolves *after* top-level
// evaluation, so an entry that calls app.listen() resolves the moment listen
// returns and the loader exits 0 immediately (killing the dangling socket); an
// entry that throws at import rejects and the loader exits 1 with the stack.
//
// Design rules:
// - Host-only; the caller skips it when a sandbox executor is active so model
//   code is never executed on the host to escape a sandbox.
// - Inconclusive outcomes (deps not installed, timeout) are advisory, not
//   failures — only a clean thrown error is a real failure.
// - Zero runtime dependencies; Node.js 24 built-ins only.

import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { isJsFile } from './syntax-gate.mjs';

export const DEFAULT_SMOKE_TIMEOUT_MS = 15000;

// The child process loader. Reads the entry path from KODR_SMOKE_ENTRY so the
// path is never interpolated into the eval'd source.
const LOADER_SOURCE = [
	'const { pathToFileURL } = await import("node:url");',
	'try {',
	'  await import(pathToFileURL(process.env.KODR_SMOKE_ENTRY).href);',
	'} catch (e) {',
	'  process.stderr.write(String(e && e.stack ? e.stack : e));',
	'  process.exit(1);',
	'}',
	'process.exit(0);',
].join('\n');

function isSafeRelative(path) {
	if (!path || isAbsolute(path)) return false;
	return !path.split(/[\\/]+/u).includes('..');
}

/**
 * Parse `node <file>` out of an npm "start" script. Returns the file argument
 * when the script is exactly `node <file>` (optionally with a leading path like
 * `node ./src/server.mjs`), else null. Anything fancier (env vars, flags, &&,
 * nodemon, ts-node, …) is intentionally not matched — we only smoke-test plain
 * Node entries.
 */
export function entryFromStartScript(startScript) {
	if (typeof startScript !== 'string') return null;
	const m = /^\s*node\s+([^\s]+)\s*$/u.exec(startScript);
	if (!m) return null;
	const file = m[1].replace(/^\.\//u, '');
	return isSafeRelative(file) && isJsFile(file) ? file : null;
}

/**
 * Resolve a path from a package.json `exports` field value.
 * Returns the first safe, relative JS file path found, or null.
 *
 * Handles:
 *   exports: "./src/index.mjs"           → string
 *   exports: { ".": "./src/index.mjs" }  → object with "." key as string
 *   exports: { ".": { import: "./src/index.mjs" } }  → conditional
 *   exports: { import: "./src/index.mjs" } → bare conditional (no "." subpath)
 *
 * @param {unknown} exportsField  The `exports` value from package.json.
 * @returns {string|null}
 */
export function entryFromExports(exportsField) {
	if (
		!exportsField ||
		(typeof exportsField !== 'object' && typeof exportsField !== 'string')
	) {
		return null;
	}
	// String form: exports: "./src/index.mjs"
	if (typeof exportsField === 'string') {
		const p = exportsField.replace(/^\.\//u, '');
		return isSafeRelative(p) && isJsFile(p) ? p : null;
	}
	// Object form: resolve the "." subpath first, then bare conditional
	const dotEntry = exportsField['.'] ?? exportsField;
	if (typeof dotEntry === 'string') {
		const p = dotEntry.replace(/^\.\//u, '');
		return isSafeRelative(p) && isJsFile(p) ? p : null;
	}
	if (dotEntry && typeof dotEntry === 'object') {
		// Conditional exports — prefer import > node > default
		for (const key of ['import', 'node', 'default']) {
			const v = dotEntry[key];
			if (typeof v === 'string') {
				const p = v.replace(/^\.\//u, '');
				if (isSafeRelative(p) && isJsFile(p)) return p;
			}
		}
	}
	return null;
}

/**
 * Detect a JS entry point for the project at `cwd` from package.json.
 * Preference order: scripts.start (node <file>) → exports → main.
 * Returns { path, source: 'start'|'exports'|'main' } for an existing,
 * in-workspace JS file, else null.
 *
 * @param {string} cwd  Workspace root (absolute path).
 * @returns {Promise<{path: string, source: string}|null>}
 */
export async function detectEntryPoint(cwd) {
	let pkg;
	try {
		pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
	} catch {
		return null;
	}

	const candidates = [];
	const fromStart = entryFromStartScript(pkg?.scripts?.start);
	if (fromStart) candidates.push({ path: fromStart, source: 'start' });
	// Phase 164: package.json `exports` field (modern ESM packages).
	if (pkg?.exports !== undefined) {
		const fromExports = entryFromExports(pkg.exports);
		if (fromExports) candidates.push({ path: fromExports, source: 'exports' });
	}
	if (typeof pkg?.main === 'string') {
		const main = pkg.main.replace(/^\.\//u, '');
		if (isSafeRelative(main) && isJsFile(main)) {
			candidates.push({ path: main, source: 'main' });
		}
	}

	for (const candidate of candidates) {
		try {
			await access(join(cwd, candidate.path));
			return candidate;
		} catch {
			// candidate file does not exist on disk; try the next one
		}
	}
	return null;
}

/**
 * Classify child stderr from a non-zero exit. A bare-specifier module-not-found
 * means dependencies are not installed (the default pipeline does not run
 * `npm install`), which is inconclusive — not a code failure. Everything else
 * (missing export, ReferenceError, throw at top level, …) is a real failure.
 *
 * @param {string} stderr
 * @returns {{status: 'failed'|'skipped', message: string}}
 */
export function classifyLoadFailure(stderr) {
	const text = stderr || '';
	const message = firstMeaningfulLine(text);
	const depMissing =
		/ERR_MODULE_NOT_FOUND/u.test(text) ||
		/Cannot find (?:package|module)\b/u.test(text);
	if (depMissing) {
		return {
			status: 'skipped',
			message: `dependencies not installed (${message}) — smoke-check skipped`,
		};
	}
	// Node exits non-zero (code 13) when a top-level await never settles and the
	// event loop empties. Nothing was thrown, so this is inconclusive, not a
	// failure — treat it as advisory rather than failing the run.
	if (/unsettled top-level await/iu.test(text)) {
		return {
			status: 'skipped',
			message:
				'entry has an unsettled top-level await — smoke-check inconclusive',
		};
	}
	// Phase 161: network-connection errors at load time mean the entry tried to
	// reach an external resource (DB, Redis, …) that is not available at probe
	// time. The code itself may be fine — inconclusive, not a failure.
	// Covers: ECONNREFUSED, ECONNRESET, ENOTFOUND, ETIMEDOUT, EHOSTUNREACH,
	// EADDRINUSE (port already in use — code is fine, probe environment is not).
	const networkError =
		/\bECONNREFUSED\b/u.test(text) ||
		/\bECONNRESET\b/u.test(text) ||
		/\bENOTFOUND\b/u.test(text) ||
		/\bETIMEDOUT\b/u.test(text) ||
		/\bEHOSTUNREACH\b/u.test(text) ||
		/\bEADDRINUSE\b/u.test(text);
	if (networkError) {
		return {
			status: 'skipped',
			message: `network error at load time (${message}) — smoke-check inconclusive`,
		};
	}
	return { status: 'failed', message };
}

function firstMeaningfulLine(stderr) {
	const lines = (stderr || '').split('\n').map((l) => l.trim());
	// Prefer a named error line (SyntaxError:, TypeError:, ReferenceError:, …).
	const named = lines.find((l) => /^[A-Z][A-Za-z]*Error:/u.test(l));
	if (named) return named;
	const first = lines.find((l) => l.length > 0 && !l.startsWith('at '));
	return first || 'load failed';
}

/**
 * Run the load probe against an entry (workspace-relative path).
 * Returns { ok, status, entry, source, message, durationMs }.
 *   status: 'ok' | 'failed' | 'skipped' | 'timeout'
 *
 * @param {string} cwd  Workspace root (absolute path).
 * @param {{path: string, source?: string}} entry
 * @param {{timeoutMs?: number, spawnFn?: Function}} [opts]
 */
export async function runSmokeCheck(cwd, entry, opts = {}) {
	const timeoutMs = opts.timeoutMs || DEFAULT_SMOKE_TIMEOUT_MS;
	const spawnFn = opts.spawnFn || spawn;
	const abs = join(cwd, entry.path);
	const started = performance.now();
	const base = { entry: entry.path, source: entry.source || '' };

	return new Promise((resolve) => {
		const child = spawnFn(
			process.execPath,
			['--input-type=module', '--eval', LOADER_SOURCE],
			{
				cwd,
				detached: true,
				env: { ...process.env, KODR_SMOKE_ENTRY: abs },
				stdio: ['ignore', 'ignore', 'pipe'],
			},
		);
		const stderrChunks = [];
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				child.kill('SIGTERM');
			}
		}, timeoutMs);

		child.stderr?.on('data', (chunk) => stderrChunks.push(chunk));
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve({
				...base,
				ok: false,
				status: 'failed',
				message: err.message,
				durationMs: Math.round(performance.now() - started),
			});
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			const durationMs = Math.round(performance.now() - started);
			if (timedOut) {
				resolve({
					...base,
					ok: false,
					status: 'timeout',
					message: `entry did not finish loading within ${timeoutMs}ms`,
					durationMs,
				});
				return;
			}
			if (code === 0) {
				resolve({ ...base, ok: true, status: 'ok', message: '', durationMs });
				return;
			}
			const stderr = Buffer.concat(stderrChunks).toString('utf8');
			const { status, message } = classifyLoadFailure(stderr);
			resolve({
				...base,
				ok: false,
				status,
				message,
				durationMs,
			});
		});
	});
}

/**
 * Convenience gate: run the smoke-check only when writes were applied, at least
 * one JS file was written, smoke-checking is enabled, no sandbox executor is
 * active, and an entry point is detectable. Returns null otherwise (so the
 * summary omits smokeCheck entirely).
 *
 * @param {string} cwd  Workspace root (absolute path).
 * @param {object} writeResult  { applied: boolean, writes: [{ path }] }
 * @param {{enabled?: boolean, sandboxActive?: boolean, timeoutMs?: number, spawnFn?: Function}} [opts]
 * @returns {Promise<object|null>}
 */
export async function runSmokeCheckIfNeeded(cwd, writeResult, opts = {}) {
	if (opts.enabled === false) return null;
	if (opts.sandboxActive) return null;
	if (!writeResult?.applied) return null;
	const paths = Array.isArray(writeResult.writes)
		? writeResult.writes.map((w) => w.path)
		: [];
	if (!paths.some((p) => typeof p === 'string' && isJsFile(p))) return null;
	const entry = await detectEntryPoint(cwd);
	if (!entry) return null;
	return runSmokeCheck(cwd, entry, opts);
}
