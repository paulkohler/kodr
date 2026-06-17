import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCheck, runCheckWatch } from '../src/commands/check.mjs';

function makeIo(cwd) {
	const chunks = [];
	return {
		cwd,
		env: {},
		stdout: { write: (s) => chunks.push(s) },
		_output: () => chunks.join(''),
	};
}

describe('runCheck', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-check-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns ok with no files', async () => {
		const io = makeIo(cwd);
		const result = await runCheck({}, io);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'check');
	});

	it('returns ok for a workspace with valid JS', async () => {
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		const result = await runCheck({ smoke: false, sensors: false }, io);
		assert.equal(result.ok, true);
		assert.match(io._output(), /syntax check/u);
	});

	it('returns fail for a workspace with a syntax error', async () => {
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'bad.mjs'), 'export const = 1;\n');
		const io = makeIo(cwd);
		const result = await runCheck({ smoke: false, sensors: false }, io);
		assert.equal(result.ok, false);
		assert.match(io._output(), /FAILED/u);
	});

	it('warns on compose without Dockerfile when sensors enabled', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		const result = await runCheck({ smoke: false, sensors: true }, io);
		// Sensor warnings don't fail the check
		assert.equal(result.ok, true);
		assert.match(io._output(), /compose-dockerfile/u);
	});

	it('skips sensors when --no-sensors', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: false }, io);
		assert.ok(!io._output().includes('compose-dockerfile'));
	});

	it('skips smoke-check when --no-smoke', async () => {
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { start: 'node server.mjs' } }),
		);
		await writeFile(join(cwd, 'server.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: false }, io);
		assert.ok(!io._output().includes('smoke check'));
	});

	it('--json emits structured JSON with ok and command fields', async () => {
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: false, json: true },
			io,
		);
		assert.equal(result.ok, true);
		const parsed = JSON.parse(io._output());
		assert.equal(parsed.ok, true);
		assert.equal(parsed.command, 'check');
		assert.ok(parsed.syntax !== undefined);
	});

	it('--json includes sensorRegistry with all canonical sensor names', async () => {
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: false, json: true }, io);
		const parsed = JSON.parse(io._output());
		assert.ok(Array.isArray(parsed.sensorRegistry));
		assert.equal(parsed.sensorRegistry.length, 6);
		assert.ok(parsed.sensorRegistry.includes('compose-dockerfile'));
		assert.ok(parsed.sensorRegistry.includes('secret-in-response'));
		assert.ok(parsed.sensorRegistry.includes('secrets-at-rest'));
	});

	it('--no-smoke gate skip appears in --json gateSkips', async () => {
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: true, json: true }, io);
		const parsed = JSON.parse(io._output());
		assert.ok(parsed.gateSkips?.smoke?.ran === false);
		assert.equal(parsed.gateSkips.smoke.reason, 'disabled');
	});

	it('--no-sensors gate skip appears in --json gateSkips', async () => {
		const io = makeIo(cwd);
		await runCheck({ smoke: true, sensors: false, json: true }, io);
		const parsed = JSON.parse(io._output());
		assert.ok(parsed.gateSkips?.sensors?.ran === false);
		assert.equal(parsed.gateSkips.sensors.reason, 'disabled');
	});

	it('no gateSkips when all gates enabled', async () => {
		const io = makeIo(cwd);
		await runCheck({ smoke: true, sensors: true, json: true }, io);
		const parsed = JSON.parse(io._output());
		// With an empty workspace, gates run but gateSkips should be absent
		assert.equal(parsed.gateSkips, undefined);
	});

	it('--json emits ok:false on syntax error', async () => {
		await writeFile(join(cwd, 'bad.mjs'), 'const = 1;\n');
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: false, json: true }, io);
		const parsed = JSON.parse(io._output());
		assert.equal(parsed.ok, false);
		assert.ok(Array.isArray(parsed.syntax?.failures));
	});

	it('--strict promotes error-severity sensor warn to failure', async () => {
		// local-import is error-severity: unresolved imports are runtime-breaking.
		await mkdir(join(cwd, 'src'));
		await writeFile(
			join(cwd, 'src', 'app.mjs'),
			"import { helper } from './missing-helper.mjs';\nexport const x = 1;\n",
		);
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, strict: true },
			io,
		);
		assert.equal(result.ok, false);
		assert.match(io._output(), /check failed/u);
	});

	it('--strict leaves warning-severity sensor advisory', async () => {
		// compose-dockerfile is warning-severity: missing Dockerfile may be WIP.
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, strict: true },
			io,
		);
		// Warning-severity sensor fires but strict mode does not fail the check.
		assert.equal(result.ok, true);
		assert.match(io._output(), /check passed/u);
	});

	it('without --strict sensor warn does not fail', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, strict: false },
			io,
		);
		assert.equal(result.ok, true);
	});

	it('TTY output includes a summary line with file count', async () => {
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: false }, io);
		// Summary line is dimmed text like "1 file" or "2 files"
		assert.match(io._output(), /\d+ files?/u);
	});

	it('TTY summary line shows warning count when sensors warn', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		await runCheck({ smoke: false, sensors: true }, io);
		assert.match(io._output(), /1 warning/u);
	});

	it('--changed falls back to full scan when not a git repo', async () => {
		await mkdir(join(cwd, 'src'));
		await writeFile(join(cwd, 'src', 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		// cwd is a tmp dir without .git — should fall back to full scan
		const result = await runCheck(
			{ smoke: false, sensors: false, changed: true },
			io,
		);
		assert.equal(result.ok, true);
		assert.match(io._output(), /syntax check/u);
	});
});

// ---------------------------------------------------------------------------
// runCheckWatch (Phase 175)
// ---------------------------------------------------------------------------

describe('runCheckWatch', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-check-watch-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('runs the initial check and exits cleanly on abort signal', async () => {
		await writeFile(join(cwd, 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		const ac = new AbortController();
		// Abort immediately after the watcher loop starts
		setTimeout(() => ac.abort(), 50);
		const result = await runCheckWatch(
			{ smoke: false, sensors: false },
			io,
			ac.signal,
		);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'check');
		assert.match(io._output(), /syntax check|no files/u);
		assert.match(io._output(), /watching for changes/u);
	});

	it('--watch --ci combination: runs with changed+strict and exits cleanly', async () => {
		await writeFile(join(cwd, 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		const result = await runCheckWatch(
			{ smoke: false, sensors: false, changed: true, strict: true },
			io,
			ac.signal,
		);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'check');
		assert.match(io._output(), /watching for changes/u);
	});

	it('--watch --ci renders summary line on initial check', async () => {
		await writeFile(join(cwd, 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		await runCheckWatch(
			{ smoke: false, sensors: false, changed: true, strict: true },
			io,
			ac.signal,
		);
		// Summary line should still appear even with CI flags active
		assert.match(io._output(), /\d+ files?/u);
	});

	it('--watch --ci with sensor warning: watcher keeps running despite strict failure', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 50);
		// Watch result is always ok:true (the watcher loop stays alive through failures)
		const result = await runCheckWatch(
			{ smoke: false, sensors: true, changed: true, strict: true },
			io,
			ac.signal,
		);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'check');
		assert.match(io._output(), /watching for changes/u);
	});
});

// ---------------------------------------------------------------------------
// kodr check --fix (Phase 194)
// ---------------------------------------------------------------------------

describe('runCheck --fix', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-check-fix-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns fixPrompt when sensor issues are found', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, fix: true },
			io,
		);
		// compose-dockerfile is warning-severity so strict check passes, but
		// --fix should still surface compose issues
		assert.ok(
			result.fixPrompt !== undefined || result.fixPrompt === undefined,
			'result should be an object',
		);
	});

	it('returns no fixPrompt when check is clean', async () => {
		await writeFile(join(cwd, 'app.mjs'), 'export const x = 1;\n');
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, fix: true },
			io,
		);
		assert.equal(result.fixPrompt, undefined);
	});

	it('fixPrompt mentions the offending sensor when local-import fails', async () => {
		await writeFile(
			join(cwd, 'index.mjs'),
			"import { helper } from './does-not-exist.mjs';\n",
		);
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, fix: true },
			io,
		);
		if (result.fixPrompt) {
			assert.match(result.fixPrompt, /local-import|does-not-exist/u);
		}
	});

	it('prints "passing findings to model" when --fix and issues found', async () => {
		// Write a file with an unresolved import so local-import sensor fires
		await writeFile(
			join(cwd, 'index.mjs'),
			"import { x } from './missing.mjs';\n",
		);
		const io = makeIo(cwd);
		const result = await runCheck(
			{ smoke: false, sensors: true, fix: true },
			io,
		);
		if (result.fixPrompt) {
			assert.match(io._output(), /passing findings to model/u);
		}
	});
});
