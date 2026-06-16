// commands/check.mjs — kodr check: run deterministic sensors on the workspace
// without invoking a model.
//
// Phase 163. Runs the same gates that the verification pipeline applies after
// every write — syntax gate, smoke-check, cross-reference sensors — against the
// current workspace files as a standalone diagnostic. Useful before/after a run
// and as a CI gate.

import { readdir, stat } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { runCrossRefSensors } from '../cross-ref-sensor.mjs';
import { runSmokeCheckIfNeeded } from '../smoke-check.mjs';
import { runSyntaxGateIfNeeded } from '../syntax-gate.mjs';

const EXCLUDED_DIRS = new Set([
	'.git',
	'node_modules',
	'.kodr',
	'.cache',
	'dist',
	'build',
	'.next',
	'.nuxt',
]);

/**
 * Recursively collect workspace-relative file paths, excluding common
 * build/cache directories. Returns paths with forward slashes.
 *
 * @param {string} cwd       Workspace root.
 * @param {string} dir       Current directory being walked (absolute).
 * @param {string[]} results Accumulator.
 */
async function collectFiles(cwd, dir, results) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (EXCLUDED_DIRS.has(entry.name)) continue;
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(cwd, abs, results);
		} else if (entry.isFile()) {
			results.push(relative(cwd, abs).replace(/\\/gu, '/'));
		}
	}
}

const STATUS_ICON = {
	fail: '\x1b[31m✖\x1b[0m',
	ok: '\x1b[32m✔\x1b[0m',
	skip: '\x1b[2m–\x1b[0m',
	warn: '\x1b[33m⚠\x1b[0m',
};

function icon(status) {
	return STATUS_ICON[status] ?? '?';
}

/**
 * Run all deterministic gates against the current workspace.
 *
 * @param {object} options  Parsed CLI options (smoke, sensors).
 * @param {object} io       { cwd, stdout }
 */
export async function runCheck(options, io) {
	const cwd = io.cwd;
	const write = (s) => io.stdout.write(s);

	write('\x1b[1mkodr check\x1b[0m\n');
	write(`  workspace: ${cwd}\n\n`);

	// Collect all workspace files
	const allFiles = [];
	await collectFiles(cwd, cwd, allFiles);

	if (allFiles.length === 0) {
		write(`${icon('skip')} no files found\n`);
		return { ok: true, command: 'check' };
	}

	// Build a fake writeResult covering the entire workspace so the gate
	// functions (which normally operate on the write set) scan everything.
	const fakeWriteResult = {
		applied: true,
		writes: allFiles.map((p) => ({ path: p })),
	};

	let anyFail = false;

	// -----------------------------------------------------------------------
	// 1. Syntax gate
	// -----------------------------------------------------------------------
	const syntaxResult = await runSyntaxGateIfNeeded(cwd, fakeWriteResult);
	if (syntaxResult === null) {
		write(`${icon('skip')} syntax check  – no JS files\n`);
	} else if (syntaxResult.ok) {
		write(
			`${icon('ok')} syntax check  ${syntaxResult.checked} file${syntaxResult.checked !== 1 ? 's' : ''} ok\n`,
		);
	} else {
		anyFail = true;
		const failures = syntaxResult.failures
			.map((f) => `  ${f.path}: ${f.message}`)
			.join('\n');
		write(`${icon('fail')} syntax check  FAILED\n${failures}\n`);
	}

	// -----------------------------------------------------------------------
	// 2. Smoke-check (informational — never fails kodr check)
	// -----------------------------------------------------------------------
	if (options.smoke !== false) {
		const smokeResult = await runSmokeCheckIfNeeded(cwd, fakeWriteResult, {
			enabled: true,
			sandboxActive: false,
		});
		if (smokeResult === null) {
			write(`${icon('skip')} smoke check   – no entry point detected\n`);
		} else if (smokeResult.status === 'ok') {
			write(
				`${icon('ok')} smoke check   ${smokeResult.entry} loaded ok (${smokeResult.durationMs}ms)\n`,
			);
		} else if (smokeResult.status === 'failed') {
			// Advisory in kodr check — warn, don't fail
			write(
				`${icon('warn')} smoke check   ${smokeResult.entry}: ${smokeResult.message}\n`,
			);
		} else {
			write(
				`${icon('skip')} smoke check   ${smokeResult.status}: ${smokeResult.message || ''}\n`,
			);
		}
	}

	// -----------------------------------------------------------------------
	// 3. Cross-reference sensors
	// -----------------------------------------------------------------------
	if (options.sensors !== false) {
		const sensorResults = await runCrossRefSensors(cwd, fakeWriteResult, {
			enabled: true,
		});
		if (sensorResults.length === 0) {
			write(`${icon('skip')} sensors       – no compose/HTML/CSS files\n`);
		} else {
			for (const sensor of sensorResults) {
				const name = sensor.sensor.padEnd(22);
				if (sensor.status === 'ok') {
					write(`${icon('ok')} ${name} ${sensor.message}\n`);
				} else if (sensor.status === 'warn') {
					write(`${icon('warn')} ${name} ${sensor.message}\n`);
				}
			}
		}
	}

	write('\n');
	if (anyFail) {
		write('\x1b[31mcheck failed\x1b[0m\n');
		return { ok: false, command: 'check' };
	}
	write('\x1b[32mcheck passed\x1b[0m\n');
	return { ok: true, command: 'check' };
}
