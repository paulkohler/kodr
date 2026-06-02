import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	loadConfiguredHooks,
	renderHookStopFeedback,
} from '../src/command-hooks.mjs';
import { HookBlockedError } from '../src/hooks.mjs';

async function fixtureDir() {
	return mkdtemp(join(tmpdir(), 'kodr-command-hooks-'));
}

async function writeFixture(cwd, path, content) {
	const target = join(cwd, path);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content, 'utf8');
}

describe('configured command hooks', () => {
	it('does not load project hooks unless explicitly enabled', async () => {
		const cwd = await fixtureDir();
		await writeFixture(cwd, '.kodr/hooks.json', '{"hooks":{}}');
		const configured = await loadConfiguredHooks(cwd, {});
		assert.equal(configured.enabled, false);
		assert.deepEqual(configured.records, []);
	});

	it('runs a PostToolUse command hook and records it', async () => {
		const cwd = await fixtureDir();
		await writeFixture(
			cwd,
			'.kodr/hooks.json',
			JSON.stringify({
				hooks: {
					PostToolUse: [
						{
							hooks: [
								{
									args: [
										'-e',
										"let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => require('fs').writeFileSync('hook-log.json', s));",
									],
									command: process.execPath,
									type: 'command',
								},
							],
							matcher: 'run_command',
						},
					],
				},
			}),
		);

		const configured = await loadConfiguredHooks(cwd, { enableHooks: true });
		await configured.hooks.run('post_tool_use', {
			cwd,
			input: { command: 'npm test' },
			result: { ok: true },
			tool: 'run_command',
		});

		const logged = JSON.parse(
			await readFile(join(cwd, 'hook-log.json'), 'utf8'),
		);
		assert.equal(logged.tool, 'run_command');
		assert.equal(configured.records.length, 1);
		assert.equal(configured.records[0].event, 'post_tool_use');
	});

	it('supports Stop block decision control', async () => {
		const cwd = await fixtureDir();
		await writeFixture(
			cwd,
			'.kodr/hooks.json',
			JSON.stringify({
				hooks: {
					Stop: [
						{
							hooks: [
								{
									args: [
										'-e',
										"process.stdout.write(JSON.stringify({decision:'block', reason:'npm test failed'}));",
									],
									command: process.execPath,
									type: 'command',
								},
							],
						},
					],
				},
			}),
		);

		const configured = await loadConfiguredHooks(cwd, { enableHooks: true });
		await assert.rejects(
			() =>
				configured.hooks.run('stop', {
					cwd,
					finishReason: 'stop',
					response: 'done',
				}),
			(error) => {
				assert.equal(error instanceof HookBlockedError, true);
				assert.equal(error.message, 'npm test failed');
				return true;
			},
		);
		assert.match(
			renderHookStopFeedback('npm test failed'),
			/blocked stopping/u,
		);
	});

	it('matches command-shaped if conditions', async () => {
		const cwd = await fixtureDir();
		await writeFixture(
			cwd,
			'.kodr/hooks.json',
			JSON.stringify({
				hooks: {
					PostToolUse: [
						{
							hooks: [
								{
									args: [
										'-e',
										"process.stdout.write(JSON.stringify({decision:'block', reason:'rm blocked'}));",
									],
									command: process.execPath,
									if: 'run_command(rm *)',
									type: 'command',
								},
							],
							matcher: 'run_command',
						},
					],
				},
			}),
		);

		const configured = await loadConfiguredHooks(cwd, { enableHooks: true });
		await configured.hooks.run('post_tool_use', {
			cwd,
			input: { command: 'npm test' },
			result: {},
			tool: 'run_command',
		});
		await assert.rejects(
			() =>
				configured.hooks.run('post_tool_use', {
					cwd,
					input: { command: 'rm file.txt' },
					result: {},
					tool: 'run_command',
				}),
			/rm blocked/u,
		);
	});
});
