// test/syntax-gate.test.mjs — C1 (phase 121) tests for the syntax gate.
//
// Tests: syntax-error write → syntaxResult.ok false + named failure;
// clean write → ok true; non-JS skipped; gate semantics; live-mode fires.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
	isJsFile,
	parseSyntaxErrorMessage,
	runSyntaxGate,
	runSyntaxGateIfNeeded,
	syntaxResultToVerification,
} from '../src/syntax-gate.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmp;
before(async () => {
	tmp = await mkdtemp(join(tmpdir(), 'kodr-syntax-gate-'));
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

// ---------------------------------------------------------------------------
// isJsFile
// ---------------------------------------------------------------------------

describe('isJsFile', () => {
	it('returns true for .mjs', () => {
		assert.equal(isJsFile('src/foo.mjs'), true);
	});
	it('returns true for .cjs', () => {
		assert.equal(isJsFile('src/foo.cjs'), true);
	});
	it('returns true for .js', () => {
		assert.equal(isJsFile('src/foo.js'), true);
	});
	it('returns false for .py', () => {
		assert.equal(isJsFile('main.py'), false);
	});
	it('returns false for .ts', () => {
		assert.equal(isJsFile('src/foo.ts'), false);
	});
	it('returns false for .json', () => {
		assert.equal(isJsFile('package.json'), false);
	});
	it('returns false for no extension', () => {
		assert.equal(isJsFile('Makefile'), false);
	});
});

// ---------------------------------------------------------------------------
// parseSyntaxErrorMessage
// ---------------------------------------------------------------------------

describe('parseSyntaxErrorMessage', () => {
	it('extracts SyntaxError message from node --check stderr', () => {
		const stderr = `file:///tmp/ws/src/foo.mjs:3
return 1;
       ^

SyntaxError: Illegal return statement
    at internalCompileFunction (node:internal/vm:77:18)`;
		assert.equal(parseSyntaxErrorMessage(stderr), 'Illegal return statement');
	});

	it('extracts SyntaxError for unexpected token', () => {
		const stderr = `file:///tmp/x.mjs:1
@@;
^

SyntaxError: Invalid or unexpected token`;
		assert.equal(
			parseSyntaxErrorMessage(stderr),
			'Invalid or unexpected token',
		);
	});

	it('returns fallback for empty stderr', () => {
		// Empty string → fallback "syntax error"
		assert.equal(parseSyntaxErrorMessage(''), 'syntax error');
	});

	it('returns first non-empty line when no SyntaxError line', () => {
		const stderr = 'some unexpected output\nfoo';
		assert.equal(parseSyntaxErrorMessage(stderr), 'some unexpected output');
	});
});

// ---------------------------------------------------------------------------
// runSyntaxGate — clean write
// ---------------------------------------------------------------------------

describe('runSyntaxGate — clean write', () => {
	it('returns ok:true for a syntactically valid .mjs file', async () => {
		const cwd = await makeWorkspace({
			'src/valid.mjs': 'export function add(a, b) { return a + b; }\n',
		});
		const result = await runSyntaxGate(cwd, ['src/valid.mjs']);
		assert.equal(result.ok, true);
		assert.equal(result.checked, 1);
		assert.deepEqual(result.failures, []);
	});

	it('returns ok:true and checked:2 for two valid files', async () => {
		const cwd = await makeWorkspace({
			'a.mjs': 'export const x = 1;\n',
			'b.mjs': 'export const y = 2;\n',
		});
		const result = await runSyntaxGate(cwd, ['a.mjs', 'b.mjs']);
		assert.equal(result.ok, true);
		assert.equal(result.checked, 2);
		assert.deepEqual(result.failures, []);
	});
});

// ---------------------------------------------------------------------------
// runSyntaxGate — syntax error write
// ---------------------------------------------------------------------------

describe('runSyntaxGate — syntax error write', () => {
	it('returns ok:false with named failure for illegal return statement', async () => {
		const cwd = await makeWorkspace({
			'src/bad.mjs': '// top-level return\nreturn 1;\n',
		});
		const result = await runSyntaxGate(cwd, ['src/bad.mjs']);
		assert.equal(result.ok, false);
		assert.equal(result.checked, 1);
		assert.equal(result.failures.length, 1);
		assert.equal(result.failures[0].path, 'src/bad.mjs');
		// Message contains "return" or "SyntaxError" detail
		assert.ok(
			result.failures[0].message.length > 0,
			'failure message should be non-empty',
		);
		assert.match(
			result.failures[0].message,
			/return|token|statement/iu,
			'failure message should name the error type',
		);
	});

	it('returns ok:false for a stray token', async () => {
		const cwd = await makeWorkspace({
			'broken.mjs': '@@unexpected;\n',
		});
		const result = await runSyntaxGate(cwd, ['broken.mjs']);
		assert.equal(result.ok, false);
		assert.equal(result.failures.length, 1);
		assert.equal(result.failures[0].path, 'broken.mjs');
	});

	it('reports all failures when multiple JS files are broken', async () => {
		const cwd = await makeWorkspace({
			'a.mjs': 'return 1;\n',
			'b.mjs': 'return 2;\n',
		});
		const result = await runSyntaxGate(cwd, ['a.mjs', 'b.mjs']);
		assert.equal(result.ok, false);
		assert.equal(result.failures.length, 2);
	});
});

// ---------------------------------------------------------------------------
// runSyntaxGate — non-JS skipped
// ---------------------------------------------------------------------------

describe('runSyntaxGate — non-JS files skipped', () => {
	it('skips .py files entirely', async () => {
		const cwd = await makeWorkspace({
			'main.py': 'def foo(): return 1\n',
		});
		const result = await runSyntaxGate(cwd, ['main.py']);
		assert.equal(result.ok, true);
		assert.equal(result.checked, 0);
		assert.deepEqual(result.failures, []);
	});

	it('skips .json and checks only .mjs', async () => {
		const cwd = await makeWorkspace({
			'config.json': '{"key":"value"}',
			'app.mjs': 'export const x = 1;\n',
		});
		const result = await runSyntaxGate(cwd, ['config.json', 'app.mjs']);
		assert.equal(result.ok, true);
		assert.equal(result.checked, 1);
	});

	it('skips absolute paths (safety)', async () => {
		const cwd = await makeWorkspace({ 'ok.mjs': 'export const x = 1;\n' });
		const result = await runSyntaxGate(cwd, ['/etc/passwd', 'ok.mjs']);
		// /etc/passwd skipped; ok.mjs checked
		assert.equal(result.checked, 1);
	});
});

// ---------------------------------------------------------------------------
// runSyntaxGateIfNeeded
// ---------------------------------------------------------------------------

describe('runSyntaxGateIfNeeded', () => {
	it('returns null when writeResult is not applied', async () => {
		const cwd = await makeWorkspace({ 'x.mjs': 'export const x = 1;\n' });
		const result = await runSyntaxGateIfNeeded(cwd, {
			applied: false,
			writes: [{ path: 'x.mjs' }],
		});
		assert.equal(result, null);
	});

	it('returns null when no JS files in writes', async () => {
		const cwd = await makeWorkspace({ 'main.py': 'pass\n' });
		const result = await runSyntaxGateIfNeeded(cwd, {
			applied: true,
			writes: [{ path: 'main.py' }],
		});
		assert.equal(result, null);
	});

	it('returns null when writes array is empty', async () => {
		const cwd = await makeWorkspace({});
		const result = await runSyntaxGateIfNeeded(cwd, {
			applied: true,
			writes: [],
		});
		assert.equal(result, null);
	});

	it('returns syntaxResult for applied JS writes', async () => {
		const cwd = await makeWorkspace({
			'app.mjs': 'export function f() {}\n',
		});
		const result = await runSyntaxGateIfNeeded(cwd, {
			applied: true,
			writes: [{ path: 'app.mjs' }],
		});
		assert.ok(result !== null, 'should return a result for JS writes');
		assert.equal(result.ok, true);
	});

	it('returns ok:false for syntax error in applied JS write', async () => {
		const cwd = await makeWorkspace({
			'broken.mjs': 'return 99;\n',
		});
		const result = await runSyntaxGateIfNeeded(cwd, {
			applied: true,
			writes: [{ path: 'broken.mjs' }],
		});
		assert.ok(result !== null);
		assert.equal(result.ok, false);
		assert.equal(result.failures.length, 1);
		assert.equal(result.failures[0].path, 'broken.mjs');
	});
});

// ---------------------------------------------------------------------------
// syntaxResultToVerification
// ---------------------------------------------------------------------------

describe('syntaxResultToVerification', () => {
	it('produces a verification-shaped object with ok:false', () => {
		const syntaxResult = {
			ok: false,
			checked: 1,
			failures: [{ path: 'src/bad.mjs', message: 'Illegal return statement' }],
		};
		const v = syntaxResultToVerification(syntaxResult);
		assert.equal(v.ok, false);
		assert.equal(v.command, 'node --check');
		assert.equal(v.exitCode, 1);
		assert.equal(v.timedOut, false);
		assert.match(
			v.stderr,
			/SyntaxError in src\/bad\.mjs: Illegal return statement/u,
		);
	});

	it('includes all failures in stderr', () => {
		const syntaxResult = {
			ok: false,
			checked: 2,
			failures: [
				{ path: 'a.mjs', message: 'Illegal return statement' },
				{ path: 'b.mjs', message: 'Invalid or unexpected token' },
			],
		};
		const v = syntaxResultToVerification(syntaxResult);
		assert.match(v.stderr, /SyntaxError in a\.mjs/u);
		assert.match(v.stderr, /SyntaxError in b\.mjs/u);
	});
});
