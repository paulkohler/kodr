import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildRepairContext,
	computeTestDelta,
	extractFailCount,
	HealingTimeoutError,
	oneShotHeal,
	renderEscalationPrompt,
	renderWrongPathWarning,
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
		// 5s rather than 1s: under full-suite load the node --check spawn can
		// exceed 1s and make the final verification (and the test) flake.
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await oneShotHeal(cwd, failed, repairText('bad.mjs'), {
			apply: true,
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
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

	it('escalates on first no-progress turn then stops on second', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-no-progress-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const prompts = [];
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			maxTurns: 3,
			repairTurn: async ({ prompt }) => {
				prompts.push(prompt);
				return {
					text: JSON.stringify({
						scratchpad: 'still thinking',
					}),
				};
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, false);
		assert.equal(result.stopReason, 'no-progress-exhausted');
		// Turn 1 is normal, turn 2 gets escalation prompt, turn 2 also produces no changes → stop
		assert.equal(result.repairs.length, 2);
		// Turn 1 prompt is normal (no escalation)
		assert.match(prompts[0], /Repair turn 1/u);
		assert.doesNotMatch(prompts[0], /ESCALATION/u);
		// Turn 2 prompt should be the escalation prompt
		assert.match(prompts[1], /ESCALATION/u);
		assert.match(prompts[1], /proposed no changes/u);
	});

	it('warns on first wrong-path turn then stops on second', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-wrong-path-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const prompts = [];
		// Need a counter so each write is unique (otherwise snapshotDiff.changed is empty)
		let counter = 0;
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			maxTurns: 3,
			repairTurn: async ({ prompt }) => {
				prompts.push(prompt);
				counter += 1;
				return {
					text: repairText(`other${counter}.mjs`),
				};
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.stopReason, 'wrong_path_exhausted');
		assert.equal(result.healed, false);
		assert.equal(result.wrongPathWarnings, 1);
		// Second prompt should contain the path warning
		assert.match(prompts[1], /Path warning/u);
		assert.match(prompts[1], /bad\.mjs/u);
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

describe('extractFailCount', () => {
	it('counts "not ok" lines', () => {
		const result = {
			stdout: 'not ok 1 - test failed\nnot ok 2 - another\n',
			stderr: '',
		};
		assert.equal(extractFailCount(result), 2);
	});

	it('counts FAIL lines', () => {
		const result = { stdout: 'FAIL src/foo.mjs\nFAILED: 1 test\n', stderr: '' };
		assert.equal(extractFailCount(result), 2);
	});

	it('counts ✗ lines', () => {
		const result = { stdout: '✗ my test\n✗ another\n', stderr: '' };
		assert.equal(extractFailCount(result), 2);
	});

	it('counts across stdout and stderr', () => {
		const result = { stdout: 'not ok 1 - a\n', stderr: 'not ok 2 - b\n' };
		assert.equal(extractFailCount(result), 2);
	});

	it('returns 0 for passing output', () => {
		const result = { stdout: 'ok 1 - all good\nTests: 5 passed\n', stderr: '' };
		assert.equal(extractFailCount(result), 0);
	});

	it('handles null/missing fields gracefully', () => {
		assert.equal(extractFailCount({}), 0);
		assert.equal(extractFailCount(null), 0);
	});
});

describe('computeTestDelta', () => {
	it('returns improved:true when failCount decreases', () => {
		const before = { stdout: 'not ok 1\nnot ok 2\n', stderr: '' };
		const after = { stdout: 'not ok 1\n', stderr: '' };
		const delta = computeTestDelta(before, after);
		assert.equal(delta.before, 2);
		assert.equal(delta.after, 1);
		assert.equal(delta.improved, true);
	});

	it('returns improved:false when failCount stays same', () => {
		const before = { stdout: 'not ok 1\n', stderr: '' };
		const after = { stdout: 'not ok 1\n', stderr: '' };
		const delta = computeTestDelta(before, after);
		assert.equal(delta.improved, false);
	});

	it('returns improved:false when failCount increases', () => {
		const before = { stdout: 'not ok 1\n', stderr: '' };
		const after = { stdout: 'not ok 1\nnot ok 2\n', stderr: '' };
		const delta = computeTestDelta(before, after);
		assert.equal(delta.improved, false);
	});
});

describe('renderEscalationPrompt', () => {
	it('includes ESCALATION marker', () => {
		const repairContext = {
			tests: { ok: false, stdout: 'not ok 1 - foo', stderr: '' },
			scratchpad: 'thinking hard',
			failurePaths: ['src/foo.mjs'],
			files: [],
			diagnostics: null,
		};
		const prompt = renderEscalationPrompt(repairContext, {
			index: 2,
			maxTurns: 3,
		});
		assert.match(prompt, /ESCALATION/u);
		assert.match(prompt, /proposed no changes/u);
		assert.match(prompt, /thinking hard/u);
		assert.match(prompt, /not ok 1/u);
	});

	it('omits scratchpad section when empty', () => {
		const repairContext = {
			tests: { ok: false, stdout: '', stderr: '' },
			scratchpad: '',
			failurePaths: [],
			files: [],
			diagnostics: null,
		};
		const prompt = renderEscalationPrompt(repairContext, {
			index: 2,
			maxTurns: 3,
		});
		assert.doesNotMatch(prompt, /Prior scratchpad/u);
	});
});

describe('renderWrongPathWarning', () => {
	it('returns warning when writes miss failure paths', () => {
		const writes = [{ path: 'src/other.mjs' }];
		const failurePaths = ['src/foo.mjs'];
		const warning = renderWrongPathWarning(writes, failurePaths);
		assert.match(warning, /src\/other\.mjs/u);
		assert.match(warning, /src\/foo\.mjs/u);
	});

	it('returns empty string when writes touch failure path', () => {
		const writes = [{ path: 'src/foo.mjs' }];
		const failurePaths = ['src/foo.mjs'];
		const warning = renderWrongPathWarning(writes, failurePaths);
		assert.equal(warning, '');
	});

	it('returns empty string when writes array is empty', () => {
		const warning = renderWrongPathWarning([], ['src/foo.mjs']);
		assert.equal(warning, '');
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
