// test/smoke-check.test.mjs — phase 156 tests for the executable smoke-check.
//
// Covers entry-point detection, failure classification, and the real load probe
// (good module → ok; throw-at-import → failed; missing local export → failed;
// missing bare dependency → skipped; never-resolving top-level await → timeout;
// side-effectful entry → ok and fast). Plus the runSmokeCheckIfNeeded gate.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	classifyLoadFailure,
	detectEntryPoint,
	entryFromExports,
	entryFromStartScript,
	runSmokeCheck,
	runSmokeCheckIfNeeded,
	smokeResultToVerification,
} from '../src/smoke-check.mjs';

let tmp;
before(async () => {
	tmp = await mkdtemp(join(tmpdir(), 'kodr-smoke-'));
});
after(async () => {
	const { rm } = await import('node:fs/promises');
	await rm(tmp, { recursive: true, force: true });
});

async function makeWorkspace(files) {
	const cwd = await mkdtemp(join(tmp, 'ws-'));
	for (const [path, content] of Object.entries(files)) {
		const abs = join(cwd, path);
		await mkdir(join(abs, '..'), { recursive: true });
		await writeFile(abs, content, 'utf8');
	}
	return cwd;
}

const writeResultFor = (paths) => ({
	applied: true,
	writes: paths.map((path) => ({ path })),
});

// ---------------------------------------------------------------------------
// entryFromStartScript
// ---------------------------------------------------------------------------

describe('entryFromStartScript', () => {
	it('extracts the file from a plain `node <file>` script', () => {
		assert.equal(entryFromStartScript('node src/server.mjs'), 'src/server.mjs');
		assert.equal(entryFromStartScript('node ./index.mjs'), 'index.mjs');
	});

	it('rejects non-plain start scripts and non-JS / unsafe paths', () => {
		assert.equal(entryFromStartScript('nodemon src/server.mjs'), null);
		assert.equal(entryFromStartScript('node --watch src/server.mjs'), null);
		assert.equal(entryFromStartScript('NODE_ENV=prod node server.mjs'), null);
		assert.equal(entryFromStartScript('node server.py'), null);
		assert.equal(entryFromStartScript('node /abs/server.mjs'), null);
		assert.equal(entryFromStartScript('node ../escape.mjs'), null);
		assert.equal(entryFromStartScript(undefined), null);
	});
});

// ---------------------------------------------------------------------------
// detectEntryPoint
// ---------------------------------------------------------------------------

describe('detectEntryPoint', () => {
	it('prefers a `node <file>` start script over main', async () => {
		const cwd = await makeWorkspace({
			'package.json': JSON.stringify({
				main: 'index.mjs',
				scripts: { start: 'node src/server.mjs' },
			}),
			'src/server.mjs': 'export const ok = 1;',
			'index.mjs': 'export const ok = 1;',
		});
		assert.deepEqual(await detectEntryPoint(cwd), {
			path: 'src/server.mjs',
			source: 'start',
		});
	});

	it('falls back to main when there is no usable start script', async () => {
		const cwd = await makeWorkspace({
			'package.json': JSON.stringify({ main: 'index.mjs' }),
			'index.mjs': 'export const ok = 1;',
		});
		assert.deepEqual(await detectEntryPoint(cwd), {
			path: 'index.mjs',
			source: 'main',
		});
	});

	it('returns null when no package.json, no entry file, or non-JS main', async () => {
		assert.equal(await detectEntryPoint(await makeWorkspace({})), null);

		const missing = await makeWorkspace({
			'package.json': JSON.stringify({ main: 'gone.mjs' }),
		});
		assert.equal(await detectEntryPoint(missing), null);

		const nonJs = await makeWorkspace({
			'package.json': JSON.stringify({ main: 'index.py' }),
			'index.py': 'print(1)',
		});
		assert.equal(await detectEntryPoint(nonJs), null);
	});
});

// ---------------------------------------------------------------------------
// entryFromExports (phase 164)
// ---------------------------------------------------------------------------

describe('entryFromExports', () => {
	it('handles a string exports value', () => {
		assert.equal(entryFromExports('./src/index.mjs'), 'src/index.mjs');
	});

	it('handles exports with "." as string', () => {
		assert.equal(entryFromExports({ '.': './src/index.mjs' }), 'src/index.mjs');
	});

	it('handles conditional exports — prefers import over node', () => {
		const exports = {
			'.': { import: './src/esm.mjs', require: './src/cjs.cjs' },
		};
		assert.equal(entryFromExports(exports), 'src/esm.mjs');
	});

	it('handles bare conditional exports (no "." subpath)', () => {
		const exports = { import: './src/index.mjs', require: './src/index.cjs' };
		assert.equal(entryFromExports(exports), 'src/index.mjs');
	});

	it('returns null for non-JS entries', () => {
		assert.equal(entryFromExports('./src/index.ts'), null);
	});

	it('returns null for unsafe paths', () => {
		assert.equal(entryFromExports('../escape.mjs'), null);
		assert.equal(entryFromExports('/abs/path.mjs'), null);
	});

	it('returns null for null/undefined', () => {
		assert.equal(entryFromExports(null), null);
		assert.equal(entryFromExports(undefined), null);
	});
});

describe('detectEntryPoint — exports field (phase 164)', () => {
	it('uses exports when no start script or main', async () => {
		const cwd = await makeWorkspace({
			'package.json': JSON.stringify({ exports: './src/index.mjs' }),
			'src/index.mjs': 'export const x = 1;',
		});
		const r = await detectEntryPoint(cwd);
		assert.deepEqual(r, { path: 'src/index.mjs', source: 'exports' });
	});

	it('prefers start script over exports', async () => {
		const cwd = await makeWorkspace({
			'package.json': JSON.stringify({
				scripts: { start: 'node src/server.mjs' },
				exports: './src/index.mjs',
			}),
			'src/server.mjs': 'export const ok = 1;',
			'src/index.mjs': 'export const x = 1;',
		});
		const r = await detectEntryPoint(cwd);
		assert.equal(r?.source, 'start');
	});

	it('falls back to main when exports file is absent', async () => {
		const cwd = await makeWorkspace({
			'package.json': JSON.stringify({
				exports: './src/missing.mjs',
				main: 'index.mjs',
			}),
			'index.mjs': 'export const ok = 1;',
		});
		const r = await detectEntryPoint(cwd);
		assert.equal(r?.source, 'main');
	});
});

// ---------------------------------------------------------------------------
// classifyLoadFailure
// ---------------------------------------------------------------------------

describe('classifyLoadFailure', () => {
	it('treats missing bare dependency as skipped (inconclusive)', () => {
		const a = classifyLoadFailure(
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express'",
		);
		assert.equal(a.status, 'skipped');
		assert.match(a.message, /dependencies not installed/u);
	});

	it('treats a thrown error / missing export as failed', () => {
		const a = classifyLoadFailure(
			"SyntaxError: The requested module 'jsonwebtoken' does not provide an export named 'sign'\n    at ModuleJob",
		);
		assert.equal(a.status, 'failed');
		assert.match(a.message, /does not provide an export named 'sign'/u);

		const b = classifyLoadFailure('Error: boom at load\n    at file');
		assert.equal(b.status, 'failed');
		assert.equal(b.message, 'Error: boom at load');
	});

	it('phase 161: treats ECONNREFUSED as skipped (inconclusive)', () => {
		const r = classifyLoadFailure(
			'Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap',
		);
		assert.equal(r.status, 'skipped');
		assert.match(r.message, /network error at load time/u);
	});

	it('phase 161: treats ENOTFOUND as skipped', () => {
		const r = classifyLoadFailure(
			'Error: getaddrinfo ENOTFOUND db.internal\n    at GetAddrInfoReqWrap',
		);
		assert.equal(r.status, 'skipped');
	});

	it('phase 161: treats ETIMEDOUT as skipped', () => {
		const r = classifyLoadFailure('Error: connect ETIMEDOUT 10.0.0.1:6379');
		assert.equal(r.status, 'skipped');
	});

	it('phase 161: treats EADDRINUSE as skipped (port in use, not a code error)', () => {
		const r = classifyLoadFailure('Error: listen EADDRINUSE :::3000');
		assert.equal(r.status, 'skipped');
	});
});

// ---------------------------------------------------------------------------
// runSmokeCheck — the real load probe
// ---------------------------------------------------------------------------

describe('runSmokeCheck', () => {
	it('a clean module loads ok', async () => {
		const cwd = await makeWorkspace({ 'entry.mjs': 'export const x = 1;\n' });
		const result = await runSmokeCheck(cwd, { path: 'entry.mjs' });
		assert.equal(result.status, 'ok');
		assert.equal(result.ok, true);
	});

	it('a module that throws at import is a failure with the error message', async () => {
		const cwd = await makeWorkspace({
			'entry.mjs': "throw new Error('boom at load');\n",
		});
		const result = await runSmokeCheck(cwd, { path: 'entry.mjs' });
		assert.equal(result.status, 'failed');
		assert.equal(result.ok, false);
		assert.match(result.message, /boom at load/u);
	});

	it('a missing local named export is a failure (the jsonwebtoken class)', async () => {
		const cwd = await makeWorkspace({
			'dep.cjs': 'module.exports = { foo: 1 };\n',
			'entry.mjs': "import { bar } from './dep.cjs';\nexport const v = bar;\n",
		});
		const result = await runSmokeCheck(cwd, { path: 'entry.mjs' });
		assert.equal(result.status, 'failed');
		assert.equal(result.ok, false);
		assert.match(result.message, /bar|export/u);
	});

	it('a missing bare dependency is skipped, not failed', async () => {
		const cwd = await makeWorkspace({
			'entry.mjs': "import x from 'definitely-not-installed-pkg-xyz';\n",
		});
		const result = await runSmokeCheck(cwd, { path: 'entry.mjs' });
		assert.equal(result.status, 'skipped');
		assert.equal(result.ok, false);
	});

	it('a side-effectful entry (server-style) resolves ok without hanging', async () => {
		const cwd = await makeWorkspace({
			'entry.mjs': 'const t = setInterval(() => {}, 1000);\nexport { t };\n',
		});
		const result = await runSmokeCheck(cwd, { path: 'entry.mjs' });
		assert.equal(result.status, 'ok');
	});

	it('a genuinely hanging entry times out (advisory)', async () => {
		// A keep-alive timer keeps the event loop busy while a top-level await
		// stays pending, so the import never resolves and Node does not bail with
		// its unsettled-TLA exit — the probe must hit the wall-clock timeout.
		const cwd = await makeWorkspace({
			'entry.mjs':
				'setInterval(() => {}, 100000);\nawait new Promise(() => {});\n',
		});
		const result = await runSmokeCheck(
			cwd,
			{ path: 'entry.mjs' },
			{ timeoutMs: 600 },
		);
		assert.equal(result.status, 'timeout');
		assert.equal(result.ok, false);
	});

	it('an unsettled top-level await (no keep-alive) is inconclusive, not a failure', async () => {
		const cwd = await makeWorkspace({
			'entry.mjs': 'await new Promise(() => {});\n',
		});
		const result = await runSmokeCheck(cwd, { path: 'entry.mjs' });
		assert.equal(result.status, 'skipped');
		assert.equal(result.ok, false);
		assert.match(result.message, /unsettled top-level await/u);
	});
});

// ---------------------------------------------------------------------------
// runSmokeCheckIfNeeded — the gate
// ---------------------------------------------------------------------------

describe('runSmokeCheckIfNeeded', () => {
	const goodWs = () =>
		makeWorkspace({
			'package.json': JSON.stringify({ main: 'index.mjs' }),
			'index.mjs': 'export const ok = 1;\n',
		});

	it('runs when applied JS writes have a detectable entry', async () => {
		const cwd = await goodWs();
		const result = await runSmokeCheckIfNeeded(
			cwd,
			writeResultFor(['index.mjs']),
		);
		assert.equal(result.status, 'ok');
	});

	it('returns null when nothing applied, no JS written, disabled, or sandboxed', async () => {
		const cwd = await goodWs();
		assert.equal(
			await runSmokeCheckIfNeeded(cwd, {
				applied: false,
				writes: [{ path: 'index.mjs' }],
			}),
			null,
		);
		assert.equal(
			await runSmokeCheckIfNeeded(cwd, writeResultFor(['notes.md'])),
			null,
		);
		assert.equal(
			await runSmokeCheckIfNeeded(cwd, writeResultFor(['index.mjs']), {
				enabled: false,
			}),
			null,
		);
		assert.equal(
			await runSmokeCheckIfNeeded(cwd, writeResultFor(['index.mjs']), {
				sandboxActive: true,
			}),
			null,
		);
	});

	it('returns null when JS was written but no entry point is detectable', async () => {
		const cwd = await makeWorkspace({ 'lib.mjs': 'export const x = 1;\n' });
		assert.equal(
			await runSmokeCheckIfNeeded(cwd, writeResultFor(['lib.mjs'])),
			null,
		);
	});
});

// ---------------------------------------------------------------------------
// smokeResultToVerification (Phase 184)
// ---------------------------------------------------------------------------

describe('smokeResultToVerification', () => {
	it('returns ok:false', () => {
		const v = smokeResultToVerification({
			status: 'failed',
			entry: 'index.mjs',
			message: 'ReferenceError: x is not defined',
			durationMs: 45,
		});
		assert.equal(v.ok, false);
		assert.equal(v.exitCode, 1);
	});

	it('includes the entry point in the command field', () => {
		const v = smokeResultToVerification({
			status: 'failed',
			entry: 'server.mjs',
			message: 'TypeError',
			durationMs: 10,
		});
		assert.ok(v.command.includes('server.mjs'));
	});

	it('surfaces the error message in stderr', () => {
		const v = smokeResultToVerification({
			status: 'failed',
			entry: 'app.mjs',
			message: 'Cannot find module "./missing.mjs"',
			durationMs: 5,
		});
		assert.ok(v.stderr.includes('missing.mjs'));
	});

	it('uses a fallback message when message is absent', () => {
		const v = smokeResultToVerification({ status: 'failed', entry: 'a.mjs' });
		assert.ok(v.stderr.length > 0);
	});
});
