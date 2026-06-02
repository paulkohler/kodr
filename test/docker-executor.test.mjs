import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DockerExecutor,
	DockerSandboxError,
	dockerDefaults,
	validateDockerOptions,
} from '../src/docker-executor.mjs';

describe('docker executor', () => {
	it('defaults to no network unless dependency install is requested', () => {
		assert.deepEqual(dockerDefaults({}), {
			dockerImage: 'node:24-bookworm-slim',
			dockerKeep: false,
			dockerNetwork: 'none',
			dockerWorkdir: '/workspace',
		});
		assert.equal(
			dockerDefaults({ installDependencies: true }).dockerNetwork,
			'bridge',
		);
		assert.equal(
			dockerDefaults({
				dockerNetwork: 'custom-net',
				installDependencies: true,
			}).dockerNetwork,
			'custom-net',
		);
	});

	it('validates docker sandbox options', () => {
		validateDockerOptions({
			dockerImage: 'node:24',
			dockerNetwork: 'none',
			dockerSandbox: true,
			dockerWorkdir: '/workspace',
		});

		assert.throws(
			() =>
				validateDockerOptions({
					dockerImage: '',
					dockerNetwork: 'none',
					dockerSandbox: true,
					dockerWorkdir: '/workspace',
				}),
			DockerSandboxError,
		);
		assert.throws(
			() =>
				validateDockerOptions({
					dockerImage: 'node:24',
					dockerNetwork: 'none',
					dockerSandbox: true,
					dockerWorkdir: 'workspace',
				}),
			DockerSandboxError,
		);
		assert.throws(
			() =>
				validateDockerOptions({
					dockerImage: 'node:24',
					dockerNetwork: 'host; rm -rf .',
					dockerSandbox: true,
					dockerWorkdir: '/workspace',
				}),
			DockerSandboxError,
		);
	});

	it('wraps commands in docker run and records container metadata', async () => {
		const calls = [];
		const executor = new DockerExecutor(
			'/host/project',
			'/host/project/.kodr/run-1',
			{
				dockerImage: 'node:24',
				dockerKeep: true,
				dockerNetwork: 'none',
				dockerRunner: async (args) => {
					calls.push(args);
					return {
						exitCode: 0,
						stderr: '',
						stdout: 'ok',
						timedOut: false,
					};
				},
				dockerSandbox: true,
				dockerWorkdir: '/workspace',
			},
		);

		const result = await executor.run(
			'/host/project',
			{ args: ['--check', 'src/app.mjs'], bin: 'node' },
			1000,
		);

		assert.equal(result.execution.environment, 'docker');
		assert.equal(result.execution.image, 'node:24');
		assert.equal(result.execution.kept, true);
		assert.equal(result.execution.network, 'none');
		assert.equal(result.execution.command, 'node --check src/app.mjs');
		assert.match(result.execution.inspectCommand, /^docker inspect kodr-/u);
		assert.match(result.execution.shellCommand, /^docker start kodr-/u);
		assert.equal(calls.length, 1);
		assert.equal(calls[0][0], 'run');
		assert.equal(calls[0].includes('--rm'), false);
		assert.deepEqual(calls[0].slice(1, 5), [
			'--name',
			result.execution.containerName,
			'--network',
			'none',
		]);
		assert.ok(calls[0].includes('type=bind,src=/host/project,dst=/workspace'));
		assert.deepEqual(calls[0].slice(-4), [
			'node:24',
			'node',
			'--check',
			'src/app.mjs',
		]);
		assert.equal(executor.metadata().commands.length, 1);
		assert.match(executor.metadata().shellCommand, /^docker start kodr-/u);
	});
});
