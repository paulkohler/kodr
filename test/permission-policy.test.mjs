import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createPermissionPolicy,
	PermissionPolicy,
	PermissionPolicyError,
} from '../src/permission-policy.mjs';

describe('permission policy', () => {
	it('allows workspace-relative defaults without weakening later jails', () => {
		const policy = createPermissionPolicy();

		assert.equal(policy instanceof PermissionPolicy, true);
		assert.doesNotThrow(() => policy.checkRead('src/app.mjs'));
		assert.doesNotThrow(() => policy.checkWrite('README.md'));
		assert.doesNotThrow(() => policy.checkWrite('README.md', { apply: true }));
		assert.doesNotThrow(() => policy.checkCommand('npm test'));
		assert.doesNotThrow(() => policy.checkNetwork('https://example.com'));
	});

	it('denies path escapes and paths outside configured prefixes', () => {
		const policy = createPermissionPolicy({
			allowedReadPaths: ['src'],
			allowedWritePaths: ['examples'],
		});

		assert.throws(
			() => policy.checkRead('../secret.txt'),
			PermissionPolicyError,
		);
		assert.throws(
			() => policy.checkRead('/tmp/secret.txt'),
			PermissionPolicyError,
		);
		assert.throws(() => policy.checkRead('README.md'), /outside allowed read/u);
		assert.throws(
			() => policy.checkWrite('README.md'),
			/outside allowed write/u,
		);
		assert.doesNotThrow(() => policy.checkRead('src/app.mjs'));
		assert.doesNotThrow(() => policy.checkWrite('examples/demo/file.mjs'));
	});

	it('denies apply, commands, and network when configured', () => {
		const policy = createPermissionPolicy({
			allowApply: false,
			allowNetwork: false,
			allowedCommands: ['node --test'],
		});

		assert.throws(
			() => policy.checkWrite('README.md', { apply: true }),
			/applying writes is denied/iu,
		);
		assert.throws(() => policy.checkCommand('npm test'), /denied by policy/u);
		assert.throws(
			() => policy.checkNetwork('https://example.com'),
			/Network access is denied/u,
		);
		assert.doesNotThrow(() => policy.checkCommand('node --test'));
	});

	it('can restrict network hosts', () => {
		const policy = createPermissionPolicy({
			allowedNetworkHosts: ['example.com'],
		});

		assert.doesNotThrow(() => policy.checkNetwork('https://example.com/docs'));
		assert.throws(
			() => policy.checkNetwork('https://other.example/docs'),
			/Network host is denied/u,
		);
	});
});
