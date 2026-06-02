import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	chooseDependencyInstallCommand,
	DependencyInstallError,
	parseDependencyInstallCommand,
	runDependencyInstall,
} from '../src/dependency-installer.mjs';

describe('dependency installer', () => {
	it('parses allowlisted install commands', () => {
		assert.deepEqual(parseDependencyInstallCommand('npm install'), {
			args: ['install'],
			bin: 'npm',
		});
		assert.deepEqual(parseDependencyInstallCommand('npm ci'), {
			args: ['ci'],
			bin: 'npm',
		});
	});

	it('rejects injection-shaped install commands', () => {
		assert.throws(
			() => parseDependencyInstallCommand('npm install && rm -rf .'),
			DependencyInstallError,
		);
		assert.throws(
			() => parseDependencyInstallCommand('pnpm install'),
			DependencyInstallError,
		);
	});

	it('chooses npm ci when a package lock exists', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-install-choice-'));
		assert.equal(await chooseDependencyInstallCommand(cwd), 'npm install');

		await writeFile(join(cwd, 'package-lock.json'), '{}\n', 'utf8');
		assert.equal(await chooseDependencyInstallCommand(cwd), 'npm ci');
	});

	it('runs through an injected command runner and records artifacts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-install-run-'));
		const result = await runDependencyInstall(cwd, {
			runner: async (_cwd, parsed) => ({
				execution: {
					environment: 'docker',
				},
				exitCode: 0,
				stderr: '',
				stdout: `ran ${parsed.bin} ${parsed.args.join(' ')}`,
				timedOut: false,
			}),
			timeoutMs: 1000,
		});

		assert.equal(result.ok, true);
		assert.equal(result.command, 'npm install');
		assert.equal(result.execution.environment, 'docker');
		assert.match(
			await readFile(join(cwd, '.kodr', 'last-install.md'), 'utf8'),
			/npm install/u,
		);
	});
});
