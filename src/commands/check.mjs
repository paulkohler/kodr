// commands/check.mjs — kodr check: run deterministic sensors on the workspace
// without invoking a model.
//
// Phase 163. Runs the same gates that the verification pipeline applies after
// every write — syntax gate, smoke-check, cross-reference sensors — against the
// current workspace files as a standalone diagnostic. Useful before/after a run
// and as a CI gate.
//
// Phase 165: --json flag emits a structured JSON result object instead of ANSI
// text, for CI integration and scripting.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
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

function renderAnsi(checkResult, fileCount, stdout) {
	const write = (s) => stdout.write(s);

	if (fileCount === 0) {
		write(`${icon('skip')} no files found\n`);
		write('\n\x1b[32mcheck passed\x1b[0m\n');
		return;
	}

	const { syntax, smokeCheck, sensors } = checkResult;

	// Syntax
	if (syntax === null) {
		write(`${icon('skip')} syntax check  – no JS files\n`);
	} else if (syntax.ok) {
		write(
			`${icon('ok')} syntax check  ${syntax.checked} file${syntax.checked !== 1 ? 's' : ''} ok\n`,
		);
	} else {
		const failures = syntax.failures
			.map((f) => `  ${f.path}: ${f.message}`)
			.join('\n');
		write(`${icon('fail')} syntax check  FAILED\n${failures}\n`);
	}

	// Smoke-check
	if (smokeCheck === undefined) {
		// gate was disabled
	} else if (smokeCheck === null) {
		write(`${icon('skip')} smoke check   – no entry point detected\n`);
	} else if (smokeCheck.status === 'ok') {
		write(
			`${icon('ok')} smoke check   ${smokeCheck.entry} loaded ok (${smokeCheck.durationMs}ms)\n`,
		);
	} else if (smokeCheck.status === 'failed') {
		write(
			`${icon('warn')} smoke check   ${smokeCheck.entry}: ${smokeCheck.message}\n`,
		);
	} else {
		write(
			`${icon('skip')} smoke check   ${smokeCheck.status}: ${smokeCheck.message || ''}\n`,
		);
	}

	// Sensors
	if (sensors === undefined) {
		// gate was disabled
	} else if (sensors.length === 0) {
		write(`${icon('skip')} sensors       – no compose/HTML/CSS files\n`);
	} else {
		for (const sensor of sensors) {
			const name = sensor.sensor.padEnd(22);
			if (sensor.status === 'ok') {
				write(`${icon('ok')} ${name} ${sensor.message}\n`);
			} else if (sensor.status === 'warn') {
				write(`${icon('warn')} ${name} ${sensor.message}\n`);
			}
		}
	}

	write('\n');
	if (!checkResult.ok) {
		write('\x1b[31mcheck failed\x1b[0m\n');
	} else {
		write('\x1b[32mcheck passed\x1b[0m\n');
	}
}

/**
 * Run all deterministic gates against the current workspace.
 *
 * @param {object} options  Parsed CLI options (smoke, sensors, json).
 * @param {object} io       { cwd, stdout }
 * @returns {Promise<{ok: boolean, command: string, syntax?, smokeCheck?, sensors?}>}
 */
export async function runCheck(options, io) {
	const cwd = io.cwd;

	if (!options.json) {
		io.stdout.write('\x1b[1mkodr check\x1b[0m\n');
		io.stdout.write(`  workspace: ${cwd}\n\n`);
	}

	// Collect all workspace files
	const allFiles = [];
	await collectFiles(cwd, cwd, allFiles);

	// Build a fake writeResult covering the entire workspace so the gate
	// functions (which normally operate on the write set) scan everything.
	const fakeWriteResult = {
		applied: true,
		writes: allFiles.map((p) => ({ path: p })),
	};

	const checkResult = { ok: true, command: 'check' };

	// -----------------------------------------------------------------------
	// 1. Syntax gate
	// -----------------------------------------------------------------------
	const syntaxResult = await runSyntaxGateIfNeeded(cwd, fakeWriteResult);
	checkResult.syntax = syntaxResult;
	if (syntaxResult !== null && !syntaxResult.ok) checkResult.ok = false;

	// -----------------------------------------------------------------------
	// 2. Smoke-check (informational — never fails kodr check)
	// -----------------------------------------------------------------------
	if (options.smoke !== false) {
		const smokeResult = await runSmokeCheckIfNeeded(cwd, fakeWriteResult, {
			enabled: true,
			sandboxActive: false,
		});
		checkResult.smokeCheck = smokeResult;
	}

	// -----------------------------------------------------------------------
	// 3. Cross-reference sensors
	// -----------------------------------------------------------------------
	if (options.sensors !== false) {
		const sensorResults = await runCrossRefSensors(cwd, fakeWriteResult, {
			enabled: true,
		});
		checkResult.sensors = sensorResults;
	}

	// -----------------------------------------------------------------------
	// Output
	// -----------------------------------------------------------------------
	if (options.json) {
		io.stdout.write(JSON.stringify(checkResult, null, 2));
		io.stdout.write('\n');
	} else {
		renderAnsi(checkResult, allFiles.length, io.stdout);
	}

	return { ok: checkResult.ok, command: 'check' };
}
