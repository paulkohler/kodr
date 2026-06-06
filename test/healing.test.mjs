import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildRepairContext,
	HealingTimeoutError,
	oneShotHeal,
	runSelfHealingLoop,
} from '../src/healing.mjs';
import { runVerification } from '../src/verification-runner.mjs';

describe('one-shot healing', () => {
	it('dry-runs a repair by default', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await oneShotHeal(cwd, failed, repairText('bad.mjs'), {
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, false);
		assert.equal(result.writes.applied, false);
		assert.equal(result.verification, null);
		assert.equal(
			await readFile(join(cwd, 'bad.mjs'), 'utf8'),
			'export const = ;\n',
		);
		assert.match(result.repairPrompt, /previous verification failed/u);
	});

	it('repairs a failing write with explicit apply', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-apply-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await oneShotHeal(cwd, failed, repairText('bad.mjs'), {
			apply: true,
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.writes.applied, true);
		assert.match(result.repairPrompt, /previous verification failed/u);
	});

	it('does not start repair when verification already passed', async () => {
		const result = await oneShotHeal(
			'/tmp',
			{
				ok: true,
			},
			'{}',
			{
				testCommand: 'node --test',
			},
		);

		assert.equal(result.healed, false);
		assert.equal(result.reason, 'Verification already passed.');
	});

	it('runs bounded repair turns until verification passes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-loop-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async ({ prompt, repairContext }) => {
				assert.match(prompt, /previous verification failed/u);
				assert.equal(repairContext.failurePaths[0], 'bad.mjs');
				return {
					text: repairText('bad.mjs'),
				};
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.stopReason, 'healed');
		assert.equal(result.repairs.length, 1);
		assert.deepEqual(result.repairs[0].snapshotDiff.changed, [
			{ path: 'bad.mjs', status: 'modify' },
		]);
		assert.equal(
			JSON.parse(
				await readFile(join(cwd, '.kodr-repairs', 'repairs.json'), 'utf8'),
			).stopReason,
			'healed',
		);
	});

	it('packs tests output and nearby source into repair context', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-context-'));
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'server.js'), 'export const app = {};\n');
		await writeFile(
			join(cwd, 'src', 'server.test.js'),
			"describe('x', () => {});\n",
		);

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: '',
			stdout: `${cwd}/src/server.test.js:1\nReferenceError: describe is not defined`,
		});

		assert.deepEqual(context.failurePaths, ['src/server.test.js']);
		assert.deepEqual(
			context.files.map((file) => file.path),
			['src/server.test.js', 'src/server.js'],
		);
		assert.match(JSON.stringify(context.tests), /describe is not defined/u);
	});

	it('drops absolute-path suffix guesses when the real failing path exists', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-project-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		await writeFile(
			join(cwd, 'test', 'extract.test.mjs'),
			"import { test } from 'node:test';\n",
		);

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: [
				`not ok 1 - ${cwd}/test/extract.test.mjs`,
				`    at TestContext.<anonymous> (${cwd}/test/extract.test.mjs:12:10)`,
			].join('\n'),
			stdout: '',
		});

		assert.deepEqual(context.failurePaths, ['test/extract.test.mjs']);
		assert.deepEqual(
			context.files.map((file) => file.path),
			['test/extract.test.mjs', 'test/extract.mjs'],
		);
	});

	it('stops after repeated no-progress repair turns', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-no-progress-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			maxTurns: 3,
			repairTurn: async () => ({
				text: JSON.stringify({
					scratchpad: 'still thinking',
				}),
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, false);
		assert.equal(result.stopReason, 'no_progress');
		assert.equal(result.repairs.length, 2);
	});

	it('rejects repairs that avoid the failing path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-wrong-path-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			maxTurns: 2,
			repairTurn: async () => ({
				text: repairText('other.mjs'),
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.stopReason, 'wrong_path');
		assert.equal(result.healed, false);
	});

	it('artifacts hung repair turns as timeouts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-timeout-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 1,
			repairTurn: () => new Promise(() => {}),
			testCommand: 'node --check bad.mjs',
			turnTimeoutMs: 20,
		});

		assert.equal(result.stopReason, 'timeout');
		assert.equal(result.repairs[0].error.name, HealingTimeoutError.name);
		assert.equal(
			JSON.parse(
				await readFile(
					join(cwd, '.kodr-repairs', 'turn-1', 'error.json'),
					'utf8',
				),
			).name,
			'HealingTimeoutError',
		);
	});
});

function repairText(path) {
	return JSON.stringify({
		files: [
			{
				content: 'export const value = 1;\n',
				path,
			},
		],
	});
}
