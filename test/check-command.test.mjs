import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCheck } from '../src/commands/check.mjs';

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
});
