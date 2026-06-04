import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildWorkspaceSnapshot,
	OpenShellExecutor,
	OpenShellSandboxError,
	openshellDefaults,
	validateOpenShellOptions,
} from '../src/openshell-executor.mjs';

async function fixtureDir() {
	return mkdtemp(join(tmpdir(), 'kodr-openshell-'));
}

async function writeFixture(cwd, path, content = '') {
	const target = join(cwd, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, 'utf8');
}

function ok(stdout = '') {
	return { exitCode: 0, stderr: '', stdout, timedOut: false };
}

function fakeRunner(calls, options = {}) {
	return async (args, timeoutMs, input) => {
		calls.push({ args, input, timeoutMs });
		if (args[0] === '--version') {
			return options.version || ok('openshell 1.0.0');
		}
		if (args[0] === 'status') {
			return (
				options.status || ok('Gateway: local\nServer: https://127.0.0.1:8080\n')
			);
		}
		if (args[0] === 'sandbox' && args.at(-1) === '--help') {
			const command = args[1];
			return options.missingCommand === command
				? {
						exitCode: 2,
						stderr: 'unrecognized subcommand',
						stdout: '',
						timedOut: false,
					}
				: ok(`${command} help`);
		}
		return ok(options.commandStdout || '');
	};
}

describe('openshell executor', () => {
	it('defaults to an optional source, keep false, and no policy path', () => {
		assert.deepEqual(openshellDefaults({}), {
			openshellFrom: '',
			openshellKeep: false,
			openshellPolicy: '',
		});
	});

	it('rejects conflicting sandboxes and install without explicit policy', () => {
		assert.throws(
			() =>
				validateOpenShellOptions({
					dockerSandbox: true,
					openshellSandbox: true,
				}),
			OpenShellSandboxError,
		);
		assert.throws(
			() =>
				validateOpenShellOptions({
					installDependencies: true,
					openshellSandbox: true,
				}),
			/--openshell-policy/u,
		);
		validateOpenShellOptions({
			installDependencies: true,
			openshellPolicy: 'policy.yaml',
			openshellSandbox: true,
		});
	});

	it('rejects an incompatible CLI before creating a sandbox', async () => {
		const cwd = await fixtureDir();
		const calls = [];
		const executor = new OpenShellExecutor(cwd, join(cwd, '.kodr', 'run'), {
			openshellRunner: fakeRunner(calls, { missingCommand: 'exec' }),
			openshellSandbox: true,
		});

		await assert.rejects(
			() => executor.initialize(1000),
			/missing "sandbox exec"/u,
		);
		assert.equal(
			calls.some(
				(call) =>
					call.args[0] === 'sandbox' &&
					call.args[1] === 'create' &&
					call.args.at(-1) !== '--help',
			),
			false,
		);
		assert.equal(executor.metadata().available, false);
		assert.match(executor.metadata().error.message, /sandbox exec/u);
	});

	it('requires a running local loopback gateway', async () => {
		const cwd = await fixtureDir();
		const stopped = new OpenShellExecutor(cwd, join(cwd, '.kodr', 'stopped'), {
			openshellRunner: fakeRunner([], {
				status: {
					exitCode: 1,
					stderr: 'connection refused',
					stdout: '',
					timedOut: false,
				},
			}),
			openshellSandbox: true,
		});
		await assert.rejects(
			() => stopped.initialize(1000),
			/gateway is not running/u,
		);

		const remote = new OpenShellExecutor(cwd, join(cwd, '.kodr', 'remote'), {
			openshellRunner: fakeRunner([], {
				status: ok('Server: https://gateway.example.com\n'),
			}),
			openshellSandbox: true,
		});
		await assert.rejects(
			() => remote.initialize(1000),
			/local loopback gateway/u,
		);
	});

	it('creates one persistent sandbox, uploads a filtered snapshot, runs commands and hooks, then deletes it', async () => {
		const cwd = await fixtureDir();
		await writeFixture(cwd, 'src/app.mjs', 'export const ok = true;\n');
		await writeFixture(cwd, 'node_modules/pkg/index.js', 'ignored\n');
		await writeFixture(cwd, '.git/config', 'ignored\n');
		await writeFixture(cwd, '.kodr/private.txt', 'ignored\n');
		await writeFixture(cwd, 'KODR_MEMORY.md', 'ignored\n');
		await writeFixture(cwd, '.env', 'SECRET=1\n');
		await writeFixture(cwd, '.env.example', 'SECRET=\n');
		const runDir = join(cwd, '.kodr', 'runs', 'run-1');
		const calls = [];
		const executor = new OpenShellExecutor(cwd, runDir, {
			openshellRunner: fakeRunner(calls, { commandStdout: 'ok' }),
			openshellSandbox: true,
		});

		await executor.initialize(1000);
		const first = await executor.run(
			cwd,
			{ args: ['--test'], bin: 'node' },
			1000,
		);
		const hook = await executor
			.hookExecutor()
			.runHook(
				cwd,
				{ args: ['audit.mjs'], command: 'node' },
				'{"tool":"run_command"}',
				1000,
			);
		await executor.finalize(1000);

		assert.equal(first.execution.environment, 'openshell');
		assert.equal(first.execution.sandboxId, executor.sandboxId);
		assert.equal(hook.exitCode, 0);
		assert.equal(
			calls.filter(
				(call) =>
					call.args[0] === 'sandbox' &&
					call.args[1] === 'create' &&
					call.args.at(-1) !== '--help',
			).length,
			1,
		);
		const create = calls.find(
			(call) =>
				call.args[0] === 'sandbox' &&
				call.args[1] === 'create' &&
				call.args.at(-1) !== '--help',
		);
		assert.ok(create.args.includes('--no-bootstrap'));
		assert.ok(create.args.includes('--policy'));
		assert.deepEqual(create.args.slice(-2), ['--', '/bin/true']);
		const execCalls = calls.filter(
			(call) =>
				call.args[0] === 'sandbox' &&
				call.args[1] === 'exec' &&
				call.args.at(-1) !== '--help',
		);
		assert.equal(execCalls.length, 2);
		assert.deepEqual(execCalls[0].args.slice(-2), ['node', '--test']);
		assert.equal(execCalls[1].input, '{"tool":"run_command"}');
		assert.equal(
			calls.some(
				(call) =>
					call.args[0] === 'sandbox' &&
					call.args[1] === 'delete' &&
					call.args[2] === executor.sandboxId,
			),
			true,
		);
		assert.equal(executor.metadata().commands.length, 1);
		assert.equal(executor.metadata().syncCount, 3);
		assert.equal(executor.metadata().workspaceSync.writeback, false);

		const snapshotEntries = await readdir(executor.snapshotDir);
		assert.ok(snapshotEntries.includes('src'));
		assert.ok(snapshotEntries.includes('.env.example'));
		assert.equal(snapshotEntries.includes('node_modules'), false);
		assert.equal(snapshotEntries.includes('.git'), false);
		assert.equal(snapshotEntries.includes('.kodr'), false);
		assert.equal(snapshotEntries.includes('KODR_MEMORY.md'), false);
		assert.equal(snapshotEntries.includes('.env'), false);
		assert.match(
			await readFile(executor.policyPath, 'utf8'),
			/network_policies: \{\}/u,
		);
	});

	it('keeps the sandbox when requested', async () => {
		const cwd = await fixtureDir();
		const calls = [];
		const executor = new OpenShellExecutor(cwd, join(cwd, '.kodr', 'keep'), {
			openshellKeep: true,
			openshellRunner: fakeRunner(calls),
			openshellSandbox: true,
		});
		await executor.initialize(1000);
		await executor.finalize(1000);
		assert.equal(
			calls.some(
				(call) =>
					call.args[0] === 'sandbox' &&
					call.args[1] === 'delete' &&
					call.args.at(-1) !== '--help',
			),
			false,
		);
		assert.equal(executor.metadata().kept, true);
	});

	it('rejects snapshot symlinks that escape the workspace', async () => {
		const cwd = await fixtureDir();
		const outside = await fixtureDir();
		await writeFixture(outside, 'secret.txt', 'secret\n');
		await symlink(join(outside, 'secret.txt'), join(cwd, 'secret-link'));

		await assert.rejects(
			() => buildWorkspaceSnapshot(cwd, join(cwd, '.kodr', 'snapshot')),
			/symlink escapes workspace/u,
		);
	});
});
