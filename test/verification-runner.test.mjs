import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	parseVerificationCommand,
	runVerification,
	VerificationError,
} from '../src/verification-runner.mjs';

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

		const result = await runVerification(cwd, 'node --check ok.mjs', {
			timeoutMs: 1000,
		});

		assert.equal(result.ok, true);
		assert.equal(result.exitCode, 0);
		assert.match(result.trustBoundary, /trusted workspace code/u);
		assert.match(
			await readFile(join(cwd, '.kodr', 'last-test.md'), 'utf8'),
			/node --check ok\.mjs/u,
		);
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

	it('marks node test runs with zero tests as failed', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-verify-empty-'));
		await writeFile(
			join(cwd, 'package.json'),
			'{"type":"module","scripts":{"test":"node --test"}}\n',
			'utf8',
		);

		const result = await runVerification(cwd, 'npm test', {
			timeoutMs: 1000,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.ok, false, result.stdout);
		assert.match(result.stdout, /node --test/u);
	});
});
