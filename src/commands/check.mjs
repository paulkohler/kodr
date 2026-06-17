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
//
// Phase 175: --watch re-runs on file changes (300ms debounce, Ctrl-C to exit).

import { readdir, watch } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
	runCrossRefSensors,
	SENSOR_NAMES,
	SENSOR_SEVERITY,
} from '../cross-ref-sensor.mjs';
import { runGit } from '../git-workspace.mjs';
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
 * Collect files modified relative to the git index (staged + unstaged +
 * untracked). Returns workspace-relative paths with forward slashes.
 * Returns null when the workspace is not a git repository.
 *
 * @param {string} cwd  Workspace root (absolute path).
 * @returns {Promise<string[]|null>}
 */
async function collectChangedFiles(cwd) {
	let result;
	try {
		result = await runGit(cwd, ['status', '--porcelain']);
	} catch {
		return null;
	}
	if (result.exitCode !== 0) return null;
	const paths = [];
	for (const line of result.stdout.split('\n')) {
		if (!line.trim()) continue;
		// porcelain format: "XY path" or "XY old -> new" for renames
		const rest = line.slice(3).replace(/[\r]/gu, '');
		const path = rest.includes(' -> ') ? rest.split(' -> ').pop() : rest;
		if (path) paths.push(path.replace(/\\/gu, '/'));
	}
	return paths;
}

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

	// Summary line: N files · N sensors · N warnings
	const sensorsRun = Array.isArray(sensors)
		? sensors.filter((s) => s.status !== 'skipped').length
		: 0;
	const warnCount = Array.isArray(sensors)
		? sensors.filter((s) => s.status === 'warn').length
		: 0;
	const parts = [`${fileCount} file${fileCount !== 1 ? 's' : ''}`];
	if (sensorsRun > 0)
		parts.push(`${sensorsRun} sensor${sensorsRun !== 1 ? 's' : ''}`);
	if (warnCount > 0)
		parts.push(`${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
	write(`\x1b[2m${parts.join(' · ')}\x1b[0m\n`);

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
 * @param {object} options  Parsed CLI options (smoke, sensors, json, strict).
 * @param {object} io       { cwd, stdout }
 * @returns {Promise<{ok: boolean, command: string, syntax?, smokeCheck?, sensors?}>}
 */
export async function runCheck(options, io) {
	const cwd = io.cwd;

	if (!options.json) {
		io.stdout.write('\x1b[1mkodr check\x1b[0m\n');
		const modeLabel = options.changed
			? ' (--changed: git-modified files only)'
			: '';
		io.stdout.write(`  workspace: ${cwd}${modeLabel}\n\n`);
	}

	// Collect files: --changed uses git status, otherwise the full workspace.
	let allFiles;
	if (options.changed) {
		const changedFiles = await collectChangedFiles(cwd);
		if (changedFiles === null) {
			if (!options.json) {
				io.stdout.write(
					`${icon('skip')} --changed: not a git repository — scanning all files\n`,
				);
			}
			allFiles = [];
			await collectFiles(cwd, cwd, allFiles);
		} else {
			allFiles = changedFiles;
		}
	} else {
		allFiles = [];
		await collectFiles(cwd, cwd, allFiles);
	}

	// Build a fake writeResult covering the entire workspace so the gate
	// functions (which normally operate on the write set) scan everything.
	const fakeWriteResult = {
		applied: true,
		writes: allFiles.map((p) => ({ path: p })),
	};

	const checkResult = { ok: true, command: 'check' };

	// Phase 189: track gate-skip reasons so "didn't run" and "passed" are
	// distinguishable in --json output and forensics.
	const gateSkips = {};

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
	} else {
		gateSkips.smoke = { ran: false, reason: 'disabled' };
	}

	// -----------------------------------------------------------------------
	// 3. Cross-reference sensors
	// -----------------------------------------------------------------------
	if (options.sensors !== false) {
		const sensorResults = await runCrossRefSensors(cwd, fakeWriteResult, {
			enabled: true,
			deep: options.deep,
			sensorToggles: options.sensorToggles,
		});
		checkResult.sensors = sensorResults;
	} else {
		gateSkips.sensors = { ran: false, reason: 'disabled' };
	}

	if (Object.keys(gateSkips).length > 0) {
		checkResult.gateSkips = gateSkips;
	}

	// -----------------------------------------------------------------------
	// Strict mode: promote error-severity warnings to failures.
	// warning-severity sensors remain advisory even in strict mode.
	// -----------------------------------------------------------------------
	if (options.strict) {
		const smoke = checkResult.smokeCheck;
		if (smoke && smoke.status === 'failed') checkResult.ok = false;
		const sens = checkResult.sensors;
		if (
			Array.isArray(sens) &&
			sens.some(
				(s) =>
					s.status === 'warn' &&
					(s.severity ?? SENSOR_SEVERITY[s.sensor] ?? 'error') === 'error',
			)
		) {
			checkResult.ok = false;
		}
	}

	// -----------------------------------------------------------------------
	// Output
	// -----------------------------------------------------------------------
	if (options.json) {
		const jsonOut = {
			...checkResult,
			sensorRegistry: Object.values(SENSOR_NAMES),
		};
		io.stdout.write(JSON.stringify(jsonOut, null, 2));
		io.stdout.write('\n');
	} else {
		renderAnsi(checkResult, allFiles.length, io.stdout);
	}

	// Phase 194: --fix mode — synthesize a repair prompt from findings and return
	// it so the dispatcher can forward it to the run pipeline.
	if (options.fix) {
		const fixPrompt = buildFixPrompt(checkResult);
		if (fixPrompt) {
			if (!options.json) {
				io.stdout.write(
					'\n\x1b[1mkodr check --fix:\x1b[0m passing findings to model…\n\n',
				);
			}
			return { ok: checkResult.ok, command: 'check', fixPrompt };
		}
	}

	return { ok: checkResult.ok, command: 'check' };
}

/**
 * Format a single sensor issue object into a human-readable line for the fix
 * prompt. Each sensor uses a distinct issue shape; this maps them correctly.
 * Returns null for unrecognised shapes so the caller can skip silently.
 *
 * @param {string} sensorName
 * @param {object} issue
 * @returns {string|null}
 */
function formatSensorIssue(sensorName, issue) {
	switch (sensorName) {
		case 'local-import':
			// { jsPath, specifier }
			return `${sensorName} in ${issue.jsPath}: unresolved import '${issue.specifier}'`;

		case 'compose-dockerfile':
			// { buildContext, composePath, expectedDockerfile, type: 'missing-dockerfile' }
			return `${sensorName}: missing Dockerfile for build context '${issue.buildContext}' (expected ${issue.expectedDockerfile})`;

		case 'import-cycles':
			// { cycle: ['a.mjs', 'b.mjs', 'a.mjs'] }
			return issue.cycle
				? `${sensorName}: import cycle: ${issue.cycle.join(' → ')}`
				: null;

		case 'secret-in-response':
			// { jsPath, lineNo, line, pattern }
			return `${sensorName} in ${issue.jsPath}:${issue.lineNo}: potential secret response (pattern: ${issue.pattern})`;

		case 'secrets-at-rest':
			// { type: 'env-file', path } or { type: 'hardcoded', jsPath, lineNo, name, value }
			if (issue.type === 'env-file') {
				return `${sensorName}: .env file committed: ${issue.path}`;
			}
			if (issue.type === 'hardcoded') {
				return `${sensorName} in ${issue.jsPath}:${issue.lineNo}: hardcoded credential '${issue.name}'`;
			}
			return null;

		case 'css-selector':
			// { cssPath, htmlPath, selector, type: 'selector-no-element', value }
			return `${sensorName} in ${issue.cssPath}: selector '${issue.selector}' not found in ${issue.htmlPath}`;

		default:
			// Unknown sensor — emit JSON so no information is lost
			return `${sensorName}: ${JSON.stringify(issue)}`;
	}
}

/**
 * Build a targeted repair prompt from check findings.
 * Returns null when there are no actionable issues (nothing for the model to fix).
 *
 * @param {object} checkResult
 * @returns {string|null}
 */
function buildFixPrompt(checkResult) {
	const lines = [];

	// Syntax failures
	if (checkResult.syntax && !checkResult.syntax.ok) {
		for (const f of checkResult.syntax.failures ?? []) {
			lines.push(`syntax error in ${f.file}: ${f.message}`);
		}
	}

	// Sensor warnings — each sensor type uses its own issue shape
	if (Array.isArray(checkResult.sensors)) {
		for (const s of checkResult.sensors) {
			if (s.status !== 'warn') continue;
			for (const issue of s.issues ?? []) {
				const line = formatSensorIssue(s.sensor, issue);
				if (line) lines.push(line);
			}
		}
	}

	if (lines.length === 0) return null;

	return [
		'Fix the following issues found by `kodr check` in this workspace.',
		'Address only the listed issues. Do not refactor or change unrelated code.',
		'',
		...lines.map((l, i) => `${i + 1}. ${l}`),
	].join('\n');
}

const WATCH_DEBOUNCE_MS = 300;

// Directories to ignore when watching (mirrors EXCLUDED_DIRS)
const WATCH_EXCLUDED = new Set([
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
 * Run `kodr check` continuously, re-running whenever a file in the workspace
 * changes. Uses `fs/promises.watch` with `{ recursive: true }`.
 * Debounces rapid bursts of change events to a single re-run after 300ms.
 * Exits cleanly on SIGINT (Ctrl-C) or when signal is aborted (for testing).
 *
 * @param {object}       options  Same as runCheck, minus --watch.
 * @param {object}       io       { cwd, stdout }
 * @param {AbortSignal}  [signal] Optional AbortSignal to cancel the watch loop.
 * @returns {Promise<{ok: boolean, command: string}>}
 */
export async function runCheckWatch(options, io, signal) {
	const cwd = io.cwd;
	const write = (s) => io.stdout.write(s);

	const watchOptions = { ...options, watch: false };

	// Initial run
	await runCheck(watchOptions, io);
	write('\n\x1b[2mwatching for changes… (Ctrl-C to exit)\x1b[0m\n');

	let timer = null;
	let watcher = null;

	const rerun = async () => {
		write('\n\x1b[2m—— file changed ——\x1b[0m\n\n');
		await runCheck(watchOptions, io);
		write('\n\x1b[2mwatching for changes… (Ctrl-C to exit)\x1b[0m\n');
	};

	// Merge caller's signal and a SIGINT-triggered abort into one controller.
	const ac = new AbortController();
	const onSigint = () => ac.abort();
	process.once('SIGINT', onSigint);
	if (signal) {
		signal.addEventListener('abort', () => ac.abort(), { once: true });
	}

	try {
		watcher = watch(cwd, { recursive: true, signal: ac.signal });
		for await (const event of watcher) {
			if (ac.signal.aborted) break;
			// Skip changes inside excluded dirs
			const topDir = event.filename?.split(/[/\\]/u)[0] ?? '';
			if (WATCH_EXCLUDED.has(topDir)) continue;

			clearTimeout(timer);
			timer = setTimeout(rerun, WATCH_DEBOUNCE_MS);
		}
	} catch (err) {
		// AbortError is the normal exit path when signal fires
		if (err?.name !== 'AbortError') throw err;
	} finally {
		clearTimeout(timer);
		process.off('SIGINT', onSigint);
		write('\n');
	}

	return { ok: true, command: 'check' };
}
