import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	detectTestCommand,
	parseVerificationCommand,
	resolveVerificationCommand,
	runVerification,
	VerificationError,
} from '../src/verification-runner.mjs';

describe('detectTestCommand (phase 150)', () => {
	async function workspace(files) {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-detect-'));
		for (const [name, content] of Object.entries(files)) {
			const path = join(dir, name);
			await mkdir(join(path, '..'), { recursive: true });
			await writeFile(path, content);
		}
		return dir;
	}

	const withTest = JSON.stringify({ scripts: { test: 'node --test' } });

	it('picks npm test for a package.json with a test script', async () => {
		const cwd = await workspace({ 'package.json': withTest });
		assert.equal(await detectTestCommand(cwd), 'npm test');
	});

	it('picks pnpm test when a pnpm lockfile is present', async () => {
		const cwd = await workspace({
			'package.json': withTest,
			'pnpm-lock.yaml': '',
		});
		assert.equal(await detectTestCommand(cwd), 'pnpm test');
	});

	it('picks yarn test when a yarn lockfile is present', async () => {
		const cwd = await workspace({ 'package.json': withTest, 'yarn.lock': '' });
		assert.equal(await detectTestCommand(cwd), 'yarn test');
	});

	it('falls back to node --test when package.json has no test script but test files exist', async () => {
		const cwd = await workspace({
			'package.json': JSON.stringify({ name: 'x' }),
			'test/x.test.mjs': 'import "node:test";',
		});
		assert.equal(await detectTestCommand(cwd), 'node --test');
	});

	it('detects cargo test for a Rust crate', async () => {
		const cwd = await workspace({ 'Cargo.toml': '[package]\nname="x"' });
		assert.equal(await detectTestCommand(cwd), 'cargo test');
	});

	it('detects go test for a Go module', async () => {
		const cwd = await workspace({ 'go.mod': 'module x' });
		assert.equal(await detectTestCommand(cwd), 'go test ./...');
	});

	it('detects pytest when pytest config markers are present', async () => {
		const cwd = await workspace({
			'pyproject.toml': '[tool.pytest.ini_options]\n',
		});
		assert.equal(await detectTestCommand(cwd), 'pytest');
	});

	it('detects unittest for a plain Python project', async () => {
		const cwd = await workspace({ 'setup.py': 'from setuptools import setup' });
		assert.equal(await detectTestCommand(cwd), 'python3 -m unittest discover');
	});

	it('returns empty string when nothing is recognised', async () => {
		const cwd = await workspace({ 'README.md': '# hi' });
		assert.equal(await detectTestCommand(cwd), '');
	});

	it('only returns allowlisted commands', async () => {
		for (const files of [
			{ 'package.json': withTest },
			{ 'package.json': withTest, 'pnpm-lock.yaml': '' },
			{ 'Cargo.toml': '[package]' },
			{ 'go.mod': 'module x' },
			{ 'pytest.ini': '' },
			{ 'setup.cfg': '' },
		]) {
			const cwd = await workspace(files);
			const cmd = await detectTestCommand(cwd);
			assert.doesNotThrow(() => parseVerificationCommand(cmd));
		}
	});
});

describe('verification runner', () => {
	it('parses allowlisted commands', () => {
		assert.deepEqual(parseVerificationCommand('npm test'), {
			args: ['test'],
			bin: 'npm',
		});
		assert.deepEqual(parseVerificationCommand('npm run test'), {
			args: ['run', 'test'],
			bin: 'npm',
		});
		assert.deepEqual(parseVerificationCommand('node --test'), {
			args: ['--test'],
			bin: 'node',
		});
		assert.deepEqual(parseVerificationCommand('node --check src/app.mjs'), {
			args: ['--check', 'src/app.mjs'],
			bin: 'node',
		});
	});

	it('parses the phase-150 package-manager and python test commands', () => {
		assert.deepEqual(parseVerificationCommand('pnpm test'), {
			args: ['test'],
			bin: 'pnpm',
		});
		assert.deepEqual(parseVerificationCommand('yarn test'), {
			args: ['test'],
			bin: 'yarn',
		});
		assert.deepEqual(parseVerificationCommand('pytest'), {
			args: [],
			bin: 'pytest',
		});
	});

	it('still rejects injection through the new commands', () => {
		assert.throws(
			() => parseVerificationCommand('pnpm test && rm -rf .'),
			VerificationError,
		);
		assert.throws(
			() => parseVerificationCommand('pytest -k "x"; cat /etc/passwd'),
			VerificationError,
		);
	});

	it('rejects injection-shaped commands', () => {
		assert.throws(
			() => parseVerificationCommand('npm test && rm -rf .'),
			VerificationError,
		);
		assert.throws(
			() => parseVerificationCommand('node --check ../x.js'),
			VerificationError,
		);
		assert.throws(
			() => parseVerificationCommand('node -e "1+1"'),
			VerificationError,
		);
	});

	it('runs commands without a shell and writes last-test output', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-'));
		await writeFile(join(cwd, 'ok.mjs'), 'export {};\n', 'utf8');

		// 10s rather than 1s: real spawns can exceed 1s under full-suite load.
		const result = await runVerification(cwd, 'node --check ok.mjs', {
			timeoutMs: 10000,
		});

		assert.equal(result.ok, true);
		assert.equal(result.exitCode, 0);
		assert.match(result.trustBoundary, /trusted workspace code/u);
		assert.match(
			await readFile(join(cwd, '.kodr', 'last-test.md'), 'utf8'),
			/node --check ok\.mjs/u,
		);
	});

	it('fails npm verification when package.json is absent in the cwd', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-no-package-'));
		const result = await runVerification(cwd, 'npm test');

		assert.equal(result.ok, false);
		assert.equal(result.exitCode, null);
		assert.match(result.stderr, /requires package\.json/u);
		assert.match(result.stderr, /parent package/u);
	});

	it('resolves npm verification to native Node tests when package.json is absent', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-resolve-node-'));
		await mkdir(join(cwd, 'test'));
		await writeFile(
			join(cwd, 'test', 'example.test.mjs'),
			'export {};\n',
			'utf8',
		);

		const resolved = await resolveVerificationCommand(cwd, 'npm test');

		assert.equal(resolved.requestedCommand, 'npm test');
		assert.equal(resolved.command, 'node --test');
		assert.match(resolved.reason, /native Node tests/u);
	});

	it('times out long-running allowlisted commands', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-timeout-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({
				scripts: {
					test: 'node -e "setTimeout(() => {}, 10000)"',
				},
			}),
			'utf8',
		);

		const result = await runVerification(cwd, 'npm test', {
			timeoutMs: 100,
		});

		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
	});

	it('uses an injected command runner and records execution metadata', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-runner-'));
		const result = await runVerification(cwd, 'node --test', {
			runner: async (_cwd, parsed) => ({
				execution: {
					containerName: 'kodr-test',
					environment: 'docker',
				},
				exitCode: 0,
				stderr: '',
				stdout: `ran ${parsed.bin} ${parsed.args.join(' ')}`,
				timedOut: false,
			}),
			timeoutMs: 1000,
		});

		assert.equal(result.execution.environment, 'docker');
		assert.equal(result.execution.containerName, 'kodr-test');
		assert.match(
			await readFile(join(cwd, '.kodr', 'last-test.md'), 'utf8'),
			/docker/u,
		);
	});

	it('injects --test-timeout into node --test invocations', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-timeout-inject-'));
		let capturedArgs;
		await runVerification(cwd, 'node --test', {
			runner: async (_cwd, effective) => {
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: 'tests 1', timedOut: false };
			},
		});
		assert.ok(
			capturedArgs.some((a) => a.startsWith('--test-timeout=')),
			`expected --test-timeout in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('uses testTimeoutMs option for --test-timeout value', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-timeout-custom-'));
		let capturedArgs;
		await runVerification(cwd, 'node --test', {
			testTimeoutMs: 5000,
			runner: async (_cwd, effective) => {
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: 'tests 1', timedOut: false };
			},
		});
		assert.ok(
			capturedArgs.includes('--test-timeout=5000'),
			`expected --test-timeout=5000 in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('does not inject --test-timeout for non-node-test commands', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-no-inject-'));
		let capturedArgs;
		await runVerification(cwd, 'node --check ok.mjs', {
			runner: async (_cwd, effective) => {
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: '', timedOut: false };
			},
		});
		assert.ok(
			!capturedArgs.some((a) => a.startsWith('--test-timeout=')),
			`expected no --test-timeout in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('marks node test runs with zero tests as failed', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-empty-'));
		await writeFile(
			join(cwd, 'package.json'),
			'{"type":"module","scripts":{"test":"node --test"}}\n',
			'utf8',
		);

		// 10s rather than 1s: npm startup alone can exceed 1s under load.
		const result = await runVerification(cwd, 'npm test', {
			timeoutMs: 10000,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.ok, false, result.stdout);
		// Phase 230: pm rewrite means node --test runs directly; stdout is raw
		// test-runner output (no npm script prefix), but zero-test detection still works.
		assert.match(result.stdout, /tests 0/u);
	});

	// Phase 230: pm-delegated --test-timeout injection
	it('rewrites npm test to node --test and injects --test-timeout when scripts.test is bare node --test', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-pm-rewrite-npm-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'node --test' } }),
			'utf8',
		);
		let capturedBin;
		let capturedArgs;
		await runVerification(cwd, 'npm test', {
			runner: async (_cwd, effective) => {
				capturedBin = effective.bin;
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: 'tests 1', timedOut: false };
			},
		});
		assert.equal(capturedBin, 'node');
		assert.ok(
			capturedArgs.includes('--test'),
			`expected --test in args: ${capturedArgs.join(' ')}`,
		);
		assert.ok(
			capturedArgs.some((a) => a.startsWith('--test-timeout=')),
			`expected --test-timeout in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('rewrites pnpm test and yarn test to node --test with --test-timeout when scripts.test is bare node --test', async () => {
		for (const pm of ['pnpm', 'yarn']) {
			const cwd = await mkdtemp(
				join(tmpdir(), `kodr-verify-pm-rewrite-${pm}-`),
			);
			await writeFile(
				join(cwd, 'package.json'),
				JSON.stringify({ scripts: { test: 'node --test' } }),
				'utf8',
			);
			let capturedBin;
			let capturedArgs;
			await runVerification(cwd, `${pm} test`, {
				runner: async (_cwd, effective) => {
					capturedBin = effective.bin;
					capturedArgs = effective.args;
					return {
						exitCode: 0,
						stderr: '',
						stdout: 'tests 1',
						timedOut: false,
					};
				},
			});
			assert.equal(capturedBin, 'node', `${pm}: expected bin=node`);
			assert.ok(
				capturedArgs.includes('--test'),
				`${pm}: expected --test in args`,
			);
			assert.ok(
				capturedArgs.some((a) => a.startsWith('--test-timeout=')),
				`${pm}: expected --test-timeout in args: ${capturedArgs.join(' ')}`,
			);
		}
	});

	it('honors testTimeoutMs on the pm-delegated rewrite path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-pm-timeout-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'node --test' } }),
			'utf8',
		);
		let capturedArgs;
		await runVerification(cwd, 'npm test', {
			testTimeoutMs: 5000,
			runner: async (_cwd, effective) => {
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: 'tests 1', timedOut: false };
			},
		});
		assert.ok(
			capturedArgs.includes('--test-timeout=5000'),
			`expected --test-timeout=5000 in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('does not rewrite npm test when scripts.test is jest (safety guarantee)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-pm-jest-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'jest' } }),
			'utf8',
		);
		let capturedBin;
		let capturedArgs;
		await runVerification(cwd, 'npm test', {
			runner: async (_cwd, effective) => {
				capturedBin = effective.bin;
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: '', timedOut: false };
			},
		});
		assert.equal(capturedBin, 'npm');
		assert.deepEqual(capturedArgs, ['test']);
		assert.ok(
			!capturedArgs.some((a) => a.startsWith('--test-timeout=')),
			`expected no --test-timeout in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('does not rewrite npm test when scripts.test has an extra file path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-pm-extrapath-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'node --test test/*.mjs' } }),
			'utf8',
		);
		let capturedBin;
		await runVerification(cwd, 'npm test', {
			runner: async (_cwd, effective) => {
				capturedBin = effective.bin;
				return { exitCode: 0, stderr: '', stdout: '', timedOut: false };
			},
		});
		assert.equal(capturedBin, 'npm');
	});

	it('strips pre-existing --test-timeout from scripts.test and uses exactly one from testTimeoutMs', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-pm-dedup-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'node --test --test-timeout=999' } }),
			'utf8',
		);
		let capturedArgs;
		// nodeTestScript strips scripts.test's --test-timeout= by returning bare
		// ['--test']; the effective filter is a no-op here but guards the direct
		// `node --test --test-timeout=...` parse path. Either way exactly one wins.
		await runVerification(cwd, 'npm test', {
			testTimeoutMs: 7000,
			runner: async (_cwd, effective) => {
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: 'tests 1', timedOut: false };
			},
		});
		const timeoutArgs = capturedArgs.filter((a) =>
			a.startsWith('--test-timeout='),
		);
		assert.equal(
			timeoutArgs.length,
			1,
			`expected exactly one --test-timeout, got: ${capturedArgs.join(' ')}`,
		);
		assert.equal(timeoutArgs[0], '--test-timeout=7000');
	});

	it('rewrites npm run test (bin=npm) with a bare node --test script', async () => {
		// `npm run test` parses to { bin: 'npm', args: ['run', 'test'] }, so it is
		// a needsPackageJson command and qualifies for the same rewrite as `npm test`.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-pm-run-'));
		await writeFile(
			join(cwd, 'package.json'),
			JSON.stringify({ scripts: { test: 'node --test' } }),
			'utf8',
		);
		let capturedBin;
		let capturedArgs;
		await runVerification(cwd, 'npm run test', {
			runner: async (_cwd, effective) => {
				capturedBin = effective.bin;
				capturedArgs = effective.args;
				return { exitCode: 0, stderr: '', stdout: 'tests 1', timedOut: false };
			},
		});
		assert.equal(capturedBin, 'node');
		assert.ok(capturedArgs.includes('--test'));
		assert.ok(
			capturedArgs.some((a) => a.startsWith('--test-timeout=')),
			`expected --test-timeout in args: ${capturedArgs.join(' ')}`,
		);
	});

	it('allowlist stays intact: parseVerificationCommand rejects injection even post-parse rewrite', () => {
		assert.throws(
			() => parseVerificationCommand('npm test && rm -rf .'),
			VerificationError,
		);
	});
});
