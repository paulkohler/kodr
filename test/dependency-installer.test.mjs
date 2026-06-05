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

	it('falls back to npm install when an auto-chosen npm ci is out of sync', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-install-fallback-'));
		await writeFile(join(cwd, 'package-lock.json'), '{}\n', 'utf8');
		const commands = [];
		const result = await runDependencyInstall(cwd, {
			runner: async (_cwd, parsed) => {
				const command = `${parsed.bin} ${parsed.args.join(' ')}`;
				commands.push(command);
				if (command === 'npm ci') {
					return {
						exitCode: 1,
						stderr:
							'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
						stdout: '',
						timedOut: false,
					};
				}
				return {
					exitCode: 0,
					stderr: '',
					stdout: 'installed',
					timedOut: false,
				};
			},
			timeoutMs: 1000,
		});

		assert.deepEqual(commands, ['npm ci', 'npm install']);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'npm install');
		assert.equal(result.fallbackFrom, 'npm ci');
		assert.match(result.fallbackReason, /out of sync/u);
	});

	it('does not fall back after an npm ci timeout', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-install-timeout-'));
		await writeFile(join(cwd, 'package-lock.json'), '{}\n', 'utf8');
		const commands = [];
		const result = await runDependencyInstall(cwd, {
			runner: async (_cwd, parsed) => {
				commands.push(`${parsed.bin} ${parsed.args.join(' ')}`);
				return { exitCode: 1, stderr: '', stdout: '', timedOut: true };
			},
			timeoutMs: 1000,
		});

		assert.deepEqual(commands, ['npm ci']);
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.equal(result.fallbackFrom, undefined);
	});

	it('keeps an explicit npm ci strict without falling back', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-install-explicit-'));
		const commands = [];
		const result = await runDependencyInstall(cwd, {
			command: 'npm ci',
			runner: async (_cwd, parsed) => {
				commands.push(`${parsed.bin} ${parsed.args.join(' ')}`);
				return {
					exitCode: 1,
					stderr: 'out of sync',
					stdout: '',
					timedOut: false,
				};
			},
			timeoutMs: 1000,
		});

		assert.deepEqual(commands, ['npm ci']);
		assert.equal(result.ok, false);
		assert.equal(result.fallbackFrom, undefined);
	});
});
