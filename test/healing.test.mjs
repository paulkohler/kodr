import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildRepairContext,
	computeTestDelta,
	extractFailCount,
	hasNoTestsRun,
	healRepairTurnBudget,
	HealingTimeoutError,
	isNothingGenerated,
	isReasoningRunaway,
	oneShotHeal,
	renderEscalationPrompt,
	renderLoopRepairPrompt,
	renderWrongPathWarning,
	runSelfHealingLoop,
	writesReferenceTask,
} from '../src/healing.mjs';
import { ModelClientError } from '../src/model-client.mjs';
import { ProposalDraft } from '../src/tool-calls.mjs';
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
		// 5s rather than 1s: under full-suite load the node --check spawn can
		// exceed 1s and make the loop's verification (and the test) flake.
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
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
			timeoutMs: 5000,
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
		// F6: only existing files are included; the sibling test/extract.mjs does
		// not exist on disk so it must not appear as a ghost entry.
		assert.deepEqual(
			context.files.map((file) => file.path),
			['test/extract.test.mjs'],
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
			// This is a behavior test, not a timeout test. A one-second child-process
			// deadline became load-sensitive when test files ran in parallel and could
			// erase the failure path that the wrong-path classifier needs.
			timeoutMs: 10000,
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
			timeoutMs: 10000,
		});

		// D3 (revised): writes apply and verification decides; a second failing
		// wrong-path turn exhausts the loop.
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

	// D1: instrumentation
	it('D1: repair entry records durationMs, promptChars, completionChars, usage, timeoutMs', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-d1-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 1,
			repairTurn: async ({ prompt }) => ({
				text: repairText('bad.mjs'),
				raw: {
					loopBudget: { usage: { promptTokens: 10, completionTokens: 5 } },
				},
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		const entry = result.repairs[0];
		assert.equal(
			typeof entry.durationMs,
			'number',
			'durationMs should be a number',
		);
		assert.ok(entry.durationMs >= 0, 'durationMs should be non-negative');
		assert.equal(
			typeof entry.promptChars,
			'number',
			'promptChars should be a number',
		);
		assert.ok(
			entry.promptChars > 0,
			'promptChars should reflect prompt length',
		);
		assert.equal(
			typeof entry.completionChars,
			'number',
			'completionChars should be a number',
		);
		assert.ok(
			entry.completionChars > 0,
			'completionChars should reflect completion length',
		);
		assert.equal(
			typeof entry.timeoutMs,
			'number',
			'timeoutMs should be a number',
		);
		// usage from raw.loopBudget.usage
		assert.deepEqual(entry.usage, { promptTokens: 10, completionTokens: 5 });
	});

	it('D1: timeout repair entry records elapsedMs and timeoutMs, turn-meta.json written', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-d1-timeout-'));
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

		const entry = result.repairs[0];
		assert.equal(entry.stopReason, 'timeout');
		assert.equal(
			typeof entry.elapsedMs,
			'number',
			'elapsedMs on timeout entry',
		);
		assert.equal(
			typeof entry.durationMs,
			'number',
			'durationMs on timeout entry',
		);
		assert.equal(entry.completionChars, 0, 'completionChars is 0 on timeout');
		assert.equal(entry.usage, null, 'usage is null on timeout');
		assert.equal(entry.timeoutMs, 20, 'timeoutMs matches configured value');

		// turn-meta.json should also be written
		const meta = JSON.parse(
			await readFile(
				join(cwd, '.kodr-repairs', 'turn-1', 'turn-meta.json'),
				'utf8',
			),
		);
		assert.equal(meta.completionChars, 0);
		assert.equal(meta.timeoutMs, 20);
		assert.equal(meta.usage, null);
	});

	// D2: capped default timeout
	it('D2: default turnTimeoutMs is capped at 240000 when timeoutMs is larger', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-d2-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		let capturedTimeoutMs;
		// Use a short timeout for the test itself — we intercept the call
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-d2'),
			maxTurns: 1,
			repairTurn: async ({ prompt }) => {
				// The turnTimeoutMs is recorded in the repair entry
				return { text: repairText('bad.mjs') };
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 600_000, // larger than 240_000 cap
		});

		// The entry should record timeoutMs === 240_000 (the cap)
		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			240_000,
			'timeoutMs should be capped at 240000',
		);
	});

	it('D2: explicit turnTimeoutMs overrides the cap', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-d2-explicit-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-d2e'),
			maxTurns: 1,
			repairTurn: async () => ({ text: repairText('bad.mjs') }),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 600_000,
			turnTimeoutMs: 300_000, // explicit override
		});

		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			300_000,
			'explicit turnTimeoutMs should not be capped',
		);
	});

	// Phase 228: profile-aware heal per-turn timeout for wireNoStream thinking models.
	it('Phase 228: wireNoStream raises the heal turn cap to min(timeoutMs, 600000)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-228a-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-228a'),
			maxTurns: 1,
			repairTurn: async () => ({ text: repairText('bad.mjs') }),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 600_000,
			wireNoStream: true,
		});

		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			600_000,
			'wireNoStream: timeoutMs should be raised to 600000, not capped at 240000',
		);
	});

	it('Phase 228: wireNoStream cap is bounded by the 600000 ceiling, not timeoutMs', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-228b-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-228b'),
			maxTurns: 1,
			repairTurn: async () => ({ text: repairText('bad.mjs') }),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 900_000,
			wireNoStream: true,
		});

		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			600_000,
			'wireNoStream: ceiling 600000 should win over larger timeoutMs 900000',
		);
	});

	it('Phase 228: wireNoStream honors a smaller timeoutMs below the ceiling', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-228c-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-228c'),
			maxTurns: 1,
			repairTurn: async () => ({ text: repairText('bad.mjs') }),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 120_000,
			wireNoStream: true,
		});

		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			120_000,
			'wireNoStream: smaller timeoutMs 120000 should not be raised to the ceiling',
		);
	});

	it('Phase 228: explicit turnTimeoutMs still overrides under wireNoStream', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-228d-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-228d'),
			maxTurns: 1,
			repairTurn: async () => ({ text: repairText('bad.mjs') }),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 600_000,
			turnTimeoutMs: 300_000,
			wireNoStream: true,
		});

		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			300_000,
			'wireNoStream: explicit turnTimeoutMs 300000 should override the wireNoStream cap',
		);
	});

	it('Phase 228: non-wireNoStream still capped at 240000', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-228e-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs-228e'),
			maxTurns: 1,
			repairTurn: async () => ({ text: repairText('bad.mjs') }),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 600_000,
		});

		const entry = result.repairs[0];
		assert.equal(
			entry.timeoutMs,
			240_000,
			'non-wireNoStream: timeoutMs should still be capped at D2 default 240000',
		);
	});

	// D3 (revised): wrong-path writes apply, verification is ground truth, and
	// wrong-path is post-verification steering only.
	it('D3: failing wrong-path writes apply, warn once, then exhaust the loop', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-d3-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const prompts = [];
		let counter = 0;
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-d3'),
			maxTurns: 3,
			repairTurn: async ({ prompt }) => {
				prompts.push(prompt);
				counter += 1;
				return { text: repairText(`unrelated${counter}.mjs`) };
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.stopReason, 'wrong_path_exhausted');
		assert.equal(result.healed, false);
		assert.equal(result.repairs.length, 2);
		// Writes were applied — gating never blocks measurement.
		assert.equal(result.repairs[0].writes.applied, true);
		assert.equal(result.repairs[0].stopReason, '');
		assert.equal(result.repairs[1].stopReason, 'wrong_path_exhausted');
		// Second prompt carries the path warning
		assert.match(prompts[1], /Path warning/u);
		assert.match(prompts[1], /bad\.mjs/u);
	});

	it('D3: partial overlap (at least one write in-set) applies normally', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-d3-partial-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-d3p'),
			maxTurns: 1,
			// proposal includes the failing path + an unrelated path — should not be gated
			repairTurn: async () => ({
				text: JSON.stringify({
					files: [
						{ path: 'bad.mjs', content: 'export const value = 1;\n' },
						{ path: 'extra.mjs', content: '// extra\n' },
					],
				}),
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.stopReason, 'healed');
	});
});

describe('healRepairTurnBudget (phase 136)', () => {
	it('raises the default-run ceiling from 4 to 8', () => {
		// Default --max-turns is 8; the old cap throttled heal turns to 4.
		assert.equal(healRepairTurnBudget(8), 8);
	});

	it('leaves the low end (maxTurns <= 4) unchanged', () => {
		assert.equal(healRepairTurnBudget(4), 4);
		assert.equal(healRepairTurnBudget(2), 2);
		assert.equal(healRepairTurnBudget(1), 1);
	});

	it('holds the ceiling at 8 for large budgets', () => {
		assert.equal(healRepairTurnBudget(12), 8);
		assert.equal(healRepairTurnBudget(100), 8);
	});

	it('floors at 1 for zero/negative/non-finite input', () => {
		assert.equal(healRepairTurnBudget(0), 1);
		assert.equal(healRepairTurnBudget(-3), 1);
		assert.equal(healRepairTurnBudget(Number.NaN), 1);
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

// F6 tests
describe('buildRepairContext — F6 no ghost files', () => {
	it('F6: excludes nonexistent sibling source path from context files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-ghost-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		// Only the test file exists — the sibling source file does not.
		await writeFile(
			join(cwd, 'test', 'wordfreq.test.mjs'),
			"import { test } from 'node:test';\n",
		);

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `not ok 1 - ${cwd}/test/wordfreq.test.mjs`,
			stdout: '',
		});

		const paths = context.files.map((f) => f.path);
		assert.ok(
			paths.includes('test/wordfreq.test.mjs'),
			'test file should be included',
		);
		assert.ok(
			!paths.includes('test/wordfreq.mjs'),
			'ghost sibling must not be included',
		);
	});

	it('F6: includes sibling source path when it exists on disk', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-sibling-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		await writeFile(
			join(cwd, 'test', 'util.test.mjs'),
			"import { test } from 'node:test';\n",
		);
		// Also create the sibling source file
		await writeFile(join(cwd, 'test', 'util.mjs'), 'export const x = 1;\n');

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `not ok 1 - ${cwd}/test/util.test.mjs`,
			stdout: '',
		});

		const paths = context.files.map((f) => f.path);
		assert.ok(
			paths.includes('test/util.test.mjs'),
			'test file should be included',
		);
		assert.ok(
			paths.includes('test/util.mjs'),
			'existing sibling should be included',
		);
	});

	it('F6: no file in context has empty content from a nonexistent path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-no-empty-'));
		await mkdir(join(cwd, 'src'), { recursive: true });
		// Only the test file exists
		await writeFile(join(cwd, 'src', 'thing.test.mjs'), 'test content');

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `fail: ${cwd}/src/thing.test.mjs`,
			stdout: '',
		});

		for (const file of context.files) {
			assert.ok(
				file.content.length > 0,
				`file ${file.path} should have non-empty content`,
			);
		}
	});
});

describe('wrong-path verification is ground truth', () => {
	it('heals when a write outside the known set makes verification pass', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-truth-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		// The test reads ./data.json without importing it, so data.json is not
		// derivable into the repair context — a repair creating it is
		// "wrong-path" by the heuristic but genuinely fixes the failure.
		await writeFile(
			join(cwd, 'test', 'data.test.mjs'),
			[
				"import assert from 'node:assert/strict';",
				"import { readFileSync } from 'node:fs';",
				"import { test } from 'node:test';",
				"test('data file exists', () => {",
				"\tassert.equal(JSON.parse(readFileSync('data.json', 'utf8')).ok, true);",
				'});',
				'',
			].join('\n'),
		);
		const failed = await runVerification(cwd, 'node --test', {
			timeoutMs: 5000,
		});
		assert.equal(failed.ok, false);

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async () => ({
				text: JSON.stringify({
					files: [{ content: '{"ok": true}\n', path: 'data.json' }],
				}),
			}),
			testCommand: 'node --test',
			timeoutMs: 5000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.stopReason, 'healed');
	});
});

describe('buildRepairContext — D6 imported source files', () => {
	it('D6: includes the source file the failing test imports', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-import-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(
			join(cwd, 'test', 'math.test.mjs'),
			"import { add } from '../src/math.mjs';\n",
		);
		await writeFile(
			join(cwd, 'src', 'math.mjs'),
			'export function add(a, b) {\n\treturn a + b + 1;\n}\n',
		);

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `not ok 1 - ${cwd}/test/math.test.mjs`,
			stdout: '',
		});

		const paths = context.files.map((f) => f.path);
		assert.ok(
			paths.includes('src/math.mjs'),
			`imported source should be included, got: ${paths}`,
		);
	});

	it('D6: resolves extensionless relative imports via .mjs and .js', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-extless-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		await mkdir(join(cwd, 'lib'), { recursive: true });
		await writeFile(
			join(cwd, 'test', 'util.test.mjs'),
			"const util = require('../lib/util');\n",
		);
		await writeFile(join(cwd, 'lib', 'util.js'), 'module.exports = {};\n');

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `not ok 1 - ${cwd}/test/util.test.mjs`,
			stdout: '',
		});

		const paths = context.files.map((f) => f.path);
		assert.ok(
			paths.includes('lib/util.js'),
			`extensionless require target should be included, got: ${paths}`,
		);
	});

	it('D6: ignores imports that escape the workspace', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-escape-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		await writeFile(
			join(cwd, 'test', 'leak.test.mjs'),
			"import secret from '../../outside.mjs';\n",
		);
		await writeFile(
			join(dirname(cwd), 'outside.mjs'),
			'export default "outside";\n',
		);

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `not ok 1 - ${cwd}/test/leak.test.mjs`,
			stdout: '',
		});

		for (const file of context.files) {
			assert.ok(
				!file.path.includes('outside'),
				`workspace-escaping import must not be included: ${file.path}`,
			);
		}
		await rm(join(dirname(cwd), 'outside.mjs'), { force: true });
	});

	it('D6: caps the number of imported files added', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-cap-'));
		await mkdir(join(cwd, 'test'), { recursive: true });
		await mkdir(join(cwd, 'src'), { recursive: true });
		const imports = [];
		for (let i = 0; i < 8; i++) {
			await writeFile(join(cwd, 'src', `m${i}.mjs`), `export const v=${i};\n`);
			imports.push(`import { v as v${i} } from '../src/m${i}.mjs';`);
		}
		await writeFile(
			join(cwd, 'test', 'many.test.mjs'),
			`${imports.join('\n')}\n`,
		);

		const context = await buildRepairContext(cwd, {
			ok: false,
			stderr: `not ok 1 - ${cwd}/test/many.test.mjs`,
			stdout: '',
		});

		const importedCount = context.files.filter((f) =>
			f.path.startsWith('src/m'),
		).length;
		assert.ok(
			importedCount <= 5,
			`at most 5 imported files should be added, got ${importedCount}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Phase 125 — Heal task anchoring (anti goal-substitution)
// ---------------------------------------------------------------------------

describe('heal task anchoring (phase 125)', () => {
	it('buildRepairContext carries the original task', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-anchor-'));
		const context = await buildRepairContext(
			cwd,
			{ ok: false, stdout: '', stderr: '' },
			{ originalTask: 'Create wordcount.mjs that counts lines.' },
		);
		assert.equal(
			context.originalTask,
			'Create wordcount.mjs that counts lines.',
		);
	});

	it('renderEscalationPrompt includes the Original task section', () => {
		const prompt = renderEscalationPrompt(
			{
				tests: { ok: false },
				scratchpad: '',
				originalTask: 'Create wordcount.mjs that counts lines.',
			},
			{ index: 2, maxTurns: 3 },
		);
		assert.match(prompt, /## Original task/u);
		assert.match(prompt, /wordcount\.mjs/u);
	});

	it('loop repair prompt carries the original task to the model', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-anchor-loop-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});
		let seenPrompt = '';
		await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 1,
			originalTask: 'Fix the export in bad.mjs',
			repairTurn: async ({ prompt }) => {
				seenPrompt = prompt;
				return { text: repairText('bad.mjs') };
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});
		assert.match(seenPrompt, /## Original task/u);
		assert.match(seenPrompt, /Fix the export in bad\.mjs/u);
	});

	it('omits the Original task section when no task is provided', async () => {
		const prompt = renderEscalationPrompt(
			{ tests: { ok: false }, scratchpad: '', originalTask: '' },
			{ index: 1, maxTurns: 2 },
		);
		assert.doesNotMatch(prompt, /## Original task/u);
	});
});

describe('nothing-generated guard (phase 125 C2)', () => {
	it('hasNoTestsRun detects a zero-test node:test run', () => {
		assert.equal(hasNoTestsRun({ stdout: '# tests 0\n# pass 0' }), true);
		assert.equal(
			hasNoTestsRun({ stderr: 'Could not find any test files' }),
			true,
		);
		assert.equal(hasNoTestsRun({ stdout: '# tests 3\n# fail 1' }), false);
	});

	it('isNothingGenerated requires both zero writes and no tests run', () => {
		const noTests = { stdout: '# tests 0' };
		const someTests = { stdout: '# tests 2\n# fail 1' };
		assert.equal(isNothingGenerated(0, noTests), true);
		// Wrote files → not nothing-generated even if tests are zero.
		assert.equal(isNothingGenerated(2, noTests), false);
		// Real failing tests with zero writes → legitimate brownfield repair.
		assert.equal(isNothingGenerated(0, someTests), false);
		// writeCount unknown (null) → guard inert.
		assert.equal(isNothingGenerated(null, noTests), false);
	});
});

describe('heal relevance judge (phase 130)', () => {
	it('writesReferenceTask matches a written path or basename in the task text', () => {
		const writes = [{ path: 'src/wordcount.mjs' }];
		assert.equal(
			writesReferenceTask(writes, 'Create wordcount.mjs that counts lines'),
			true,
		);
		assert.equal(
			writesReferenceTask(writes, 'Build an unrelated thing'),
			false,
		);
		assert.equal(writesReferenceTask([], 'wordcount.mjs'), false);
		assert.equal(writesReferenceTask(writes, ''), false);
	});

	it('flags goal-substitution when the heal passes via an unrelated write', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-gs-'));
		const failed = {
			ok: false,
			command: 'node --check unrelated.mjs',
			exitCode: 1,
			stdout: '',
			stderr: 'src/wanted.mjs:1 SyntaxError: missing',
		};
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 1,
			originalTask: 'Fix the bug in src/wanted.mjs',
			repairTurn: async () => ({
				text: JSON.stringify({
					files: [{ path: 'unrelated.mjs', content: 'export const x = 1;\n' }],
				}),
			}),
			testCommand: 'node --check unrelated.mjs',
			timeoutMs: 5000,
		});
		assert.equal(result.healed, true);
		assert.equal(result.goalSubstitutionSuspected, true);
	});

	it('does not flag when the healing write is named in the task', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-gs-ok-'));
		const failed = {
			ok: false,
			command: 'node --check wanted.mjs',
			exitCode: 1,
			stdout: '',
			stderr: 'src/other.mjs:1 SyntaxError: missing',
		};
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 1,
			originalTask: 'Create wanted.mjs that does the thing',
			repairTurn: async () => ({
				text: JSON.stringify({
					files: [{ path: 'wanted.mjs', content: 'export const x = 1;\n' }],
				}),
			}),
			testCommand: 'node --check wanted.mjs',
			timeoutMs: 5000,
		});
		assert.equal(result.healed, true);
		assert.equal(result.goalSubstitutionSuspected, false);
	});
});

// ---------------------------------------------------------------------------
// Phase 135 — Heal Tool-Channel Parity
// ---------------------------------------------------------------------------

describe('heal tool-channel parity (phase 135)', () => {
	// Test 1: captured-draft heal with empty text (the regression this fixes).
	// A repairTurn that returns a pre-built proposal with no text (as a
	// tool-using model produces) should apply the file and heal.
	it('captured-draft heal: applies file even when text is empty', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-135-cap-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async () => ({
				// Pre-built proposal from tool-call channel; text is empty as a
				// native-tool model would produce.
				proposal: {
					files: [{ path: 'bad.mjs', content: 'export const value = 1;\n' }],
					patches: [],
				},
				text: '',
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.stopReason, 'healed');
	});

	// Test 2: envelope-only still heals (regression guard).
	// When repairTurn returns only text (no proposal), the extractor path works.
	it('envelope-only heal: still heals via text extractor', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-135-env-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async () => ({
				// No proposal key — must fall back to text extractor
				text: repairText('bad.mjs'),
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.stopReason, 'healed');
	});

	// Test 3: empty draft does not shadow a valid envelope.
	// repairTurn returns { proposal: { files: [], patches: [] }, text: <valid> }
	// → the envelope must be used (empty draft falls through to extractor).
	it('empty draft does not shadow a valid envelope', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-135-shadow-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async () => ({
				// Empty draft — must NOT suppress the valid text envelope
				proposal: { files: [], patches: [] },
				text: repairText('bad.mjs'),
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.stopReason, 'healed');
	});

	// Test 4: both channels empty → invalid_proposal (unchanged).
	it('both channels empty → invalid_proposal unchanged', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-135-empty-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 1,
			repairTurn: async () => ({
				// No proposal key, empty text — both channels empty
				text: '',
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, false);
		assert.equal(result.stopReason, 'invalid_proposal');
	});
});

// ---------------------------------------------------------------------------
// Phase 231 — Detect Heal Reasoning-Token Runaway and Fast-Fail
// ---------------------------------------------------------------------------

describe('reasoning-token runaway (phase 231)', () => {
	// (e) Pure-predicate truth table
	it('isReasoningRunaway: truth table', () => {
		// True: empty text, no proposal, finishReasons: ['length']
		assert.equal(
			isReasoningRunaway(
				'',
				{
					finishReasons: ['length'],
					loopBudget: {
						stopReason: 'finish_length',
						completionTokens: 21693,
						promptTokens: 11075,
						tokens: 32768,
					},
				},
				false,
			),
			true,
		);
		// True: stopReason: 'finish_length' also qualifies
		assert.equal(
			isReasoningRunaway(
				'',
				{
					finishReasons: ['stop'],
					loopBudget: { stopReason: 'finish_length' },
				},
				false,
			),
			true,
		);
		// False: proposalNonEmpty short-circuits
		assert.equal(
			isReasoningRunaway('', { finishReasons: ['length'] }, true),
			false,
		);
		// False: non-empty text short-circuits
		assert.equal(
			isReasoningRunaway('{"files":[]}', { finishReasons: ['length'] }, false),
			false,
		);
		// False: !raw short-circuits (keeps existing test paths unchanged)
		assert.equal(isReasoningRunaway('', undefined, false), false);
		assert.equal(isReasoningRunaway('', null, false), false);
		// False: finish_reason 'stop' with empty content is NOT a runaway
		assert.equal(
			isReasoningRunaway(
				'',
				{ finishReasons: ['stop'], loopBudget: { stopReason: 'finish_stop' } },
				false,
			),
			false,
		);
		// False: whitespace-only text is empty, but 'stop' reason means not runaway
		assert.equal(
			isReasoningRunaway('   \n', { finishReasons: ['stop'] }, false),
			false,
		);
		// True: whitespace-only text + length is still a runaway
		assert.equal(
			isReasoningRunaway('   \n', { finishReasons: ['length'] }, false),
			true,
		);
	});

	// (a) Runaway stops after ONE turn, repairs.length === 1, stopReason: 'reasoning_runaway'
	it('runaway stops after ONE turn, repairs.length===1, stopReason reasoning_runaway', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-231a-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		let repairCallCount = 0;
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			contextWindow: 32768,
			maxTurns: 3,
			repairTurn: async () => {
				repairCallCount += 1;
				// Provenance: final-audit/blog-platform/.kodr/runs/2026-06-20T04-45-40.838Z/repairs/turn-1/raw-response.json
				return {
					text: '',
					raw: {
						finishReasons: ['length'],
						loopBudget: {
							completionTokens: 21693,
							promptTokens: 11075,
							tokens: 32768,
							stopReason: 'finish_length',
						},
					},
				};
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.stopReason, 'reasoning_runaway');
		assert.equal(result.healed, false);
		assert.equal(result.repairs.length, 1, 'must stop after ONE turn');
		assert.equal(repairCallCount, 1, 'repairTurn called exactly once');
	});

	// (b) Runaway repair record carries token evidence
	it('runaway repair record carries token evidence in runaway field', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-231b-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			contextWindow: 32768,
			maxTurns: 2,
			repairTurn: async () => ({
				text: '',
				raw: {
					finishReasons: ['length'],
					loopBudget: {
						completionTokens: 21693,
						promptTokens: 11075,
						tokens: 32768,
						stopReason: 'finish_length',
					},
				},
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		const entry = result.repairs[0];
		assert.equal(entry.stopReason, 'reasoning_runaway');
		assert.ok(entry.runaway, 'repair entry must have runaway field');
		assert.equal(entry.runaway.finishReason, 'length');
		assert.equal(entry.runaway.completionTokens, 21693);
		assert.equal(entry.runaway.promptTokens, 11075);
		assert.equal(entry.runaway.totalTokens, 32768);
		assert.equal(entry.runaway.contextWindow, 32768);

		// runaway.json should be written to disk
		const runawayJson = JSON.parse(
			await readFile(
				join(cwd, '.kodr-repairs', 'turn-1', 'runaway.json'),
				'utf8',
			),
		);
		assert.equal(runawayJson.finishReason, 'length');
		assert.equal(runawayJson.completionTokens, 21693);
	});

	// (c) Regression: empty text + finish 'stop' keeps no-progress→escalate→exhaust (2 turns)
	it('regression: empty text + stop finish does NOT trigger runaway (no-progress path)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-231c-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		let repairCallCount = 0;
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			maxTurns: 3,
			repairTurn: async () => {
				repairCallCount += 1;
				// A thinking model that declined: finish_reason 'stop', empty text
				return {
					text: JSON.stringify({ scratchpad: 'thinking' }),
					raw: {
						finishReasons: ['stop'],
						loopBudget: { stopReason: 'finish_stop' },
					},
				};
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		// Must NOT be reasoning_runaway — should be no-progress-exhausted after 2 turns
		assert.equal(result.stopReason, 'no-progress-exhausted');
		assert.equal(result.repairs.length, 2);
		assert.equal(
			repairCallCount,
			2,
			'repairTurn called twice (escalate then exhaust)',
		);
	});

	// (d) Empty text + NON-EMPTY proposal heals (not a runaway)
	it('empty text + non-empty proposal heals normally (not classified as runaway)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-231d-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async () => ({
				// Pre-built proposal (tool-call channel), empty text, but finish_reason 'length'
				// proposalNonEmpty=true must prevent runaway classification
				text: '',
				raw: {
					finishReasons: ['length'],
					loopBudget: { stopReason: 'finish_length', completionTokens: 100 },
				},
				proposal: {
					files: [{ path: 'bad.mjs', content: 'export const value = 1;\n' }],
					patches: [],
				},
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.stopReason, 'healed');
		assert.notEqual(result.stopReason, 'reasoning_runaway');
	});

	// (f) Runaway on turn 2, after a real (but failing) turn 1: detection is
	// index-independent and still stops the loop the moment the runaway appears.
	it('runaway on turn 2 (after a real failing turn 1) stops with reasoning_runaway', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-231f-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		let repairCallCount = 0;
		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			contextWindow: 32768,
			maxTurns: 3,
			repairTurn: async () => {
				repairCallCount += 1;
				if (repairCallCount === 1) {
					// Turn 1 writes a real change to the failing path that is still a
					// syntax error: snapshot changes (no-progress resets), tests fail.
					return {
						text: JSON.stringify({
							files: [{ path: 'bad.mjs', content: 'export const x = ;\n' }],
						}),
						raw: {
							finishReasons: ['stop'],
							loopBudget: { stopReason: 'finish_stop' },
						},
					};
				}
				// Turn 2 runs away.
				return {
					text: '',
					raw: {
						finishReasons: ['length'],
						loopBudget: {
							completionTokens: 21693,
							promptTokens: 11075,
							tokens: 32768,
							stopReason: 'finish_length',
						},
					},
				};
			},
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.stopReason, 'reasoning_runaway');
		assert.equal(repairCallCount, 2, 'runaway detected on the second turn');
		assert.equal(result.repairs.at(-1).stopReason, 'reasoning_runaway');
	});

	// Phase 244: proximity guard tests.
	// Test A — near-cap (4094/4096): should classify as runaway
	it('244A: near-cap (4094/4096) classifies as runaway', () => {
		const raw4094 = {
			finishReasons: ['length'],
			loopBudget: { completionTokens: 4094 },
		};
		assert.equal(isReasoningRunaway('', raw4094, false, 4096), true);
	});

	// Test B — far-below-cap (100 tokens, cap 4096): should NOT classify as runaway
	it('244B: far-below-cap (100/4096) does not classify as runaway', () => {
		const raw100 = {
			finishReasons: ['length'],
			loopBudget: { completionTokens: 100 },
		};
		assert.equal(isReasoningRunaway('', raw100, false, 4096), false);
	});

	// Test C — no cap (backward compat): should still return true
	it('244C: no cap (backward compat) still classifies as runaway', () => {
		const rawLength = {
			finishReasons: ['length'],
			loopBudget: { completionTokens: 999 },
		};
		assert.equal(isReasoningRunaway('', rawLength, false), true);
	});

	// Test D — near-cap staged (7800/8192): should classify as runaway
	it('244D: near-cap staged (7800/8192) classifies as runaway', () => {
		const raw7800 = {
			finishReasons: ['length'],
			loopBudget: { completionTokens: 7800 },
		};
		assert.equal(isReasoningRunaway('', raw7800, false, 8192), true);
	});

	// (g) raw present but loopBudget absent: still a runaway (finishReasons signal
	// alone), evidence fields degrade to null without throwing.
	it('runaway with raw but no loopBudget captures null token evidence', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-231g-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			apply: true,
			artifactDir: join(cwd, '.kodr-repairs'),
			maxTurns: 2,
			repairTurn: async () => ({
				text: '',
				raw: { finishReasons: ['length'] },
			}),
			testCommand: 'node --check bad.mjs',
			timeoutMs: 5000,
		});

		assert.equal(result.stopReason, 'reasoning_runaway');
		assert.equal(result.repairs.length, 1);
		const ev = result.repairs[0].runaway;
		assert.equal(ev.finishReason, 'length');
		assert.equal(ev.completionTokens, null);
		assert.equal(ev.totalTokens, null);
		// contextWindow omitted when options.contextWindow is not finite
		assert.ok(!('contextWindow' in ev));
	});
});

// ---------------------------------------------------------------------------
// Phase 235 — ProposalDraft.clear() unit tests
// ---------------------------------------------------------------------------

describe('ProposalDraft.clear() (phase 235)', () => {
	it('clear() empties files, patches, AND alias hits; isEmpty is true afterward', () => {
		const draft = new ProposalDraft();
		draft.recordFile('src/a.mjs', 'export const a = 1;\n');
		draft.recordPatch('src/b.mjs', 'old', 'new');
		draft.recordAlias('write_file');

		// Pre-clear: everything is recorded.
		assert.equal(draft.files.length, 1, 'files before clear');
		assert.equal(draft.patches.length, 1, 'patches before clear');
		assert.deepEqual(
			draft.aliasHits,
			{ write_file: 1 },
			'aliasHits before clear',
		);
		assert.equal(draft.isEmpty, false, 'isEmpty false before clear');

		draft.clear();

		// Post-clear: all accumulators are empty.
		assert.equal(draft.files.length, 0, 'files after clear');
		assert.equal(draft.patches.length, 0, 'patches after clear');
		assert.deepEqual(draft.aliasHits, {}, 'aliasHits after clear');
		assert.equal(draft.isEmpty, true, 'isEmpty true after clear');
	});

	it('clearFiles regression: still removes only files, leaves patches (guards staged invariant)', () => {
		const draft = new ProposalDraft();
		draft.recordFile('src/a.mjs', 'export const a = 1;\n');
		draft.recordPatch('src/b.mjs', 'old', 'new');

		// clearFiles removes only the named file entry — patches untouched.
		draft.clearFiles(['src/a.mjs']);

		assert.equal(draft.files.length, 0, 'file entry removed by clearFiles');
		assert.equal(
			draft.patches.length,
			1,
			'patch entry NOT removed by clearFiles',
		);
		// isEmpty checks both _files and _patches; patch present -> not empty.
		assert.equal(draft.isEmpty, false, 'isEmpty is false when patches remain');
	});

	it('inter-turn carryover: clear() followed by new recordFile captures only the new write', () => {
		const draft = new ProposalDraft();
		// Simulate a main-run write (or a prior heal turn's write).
		draft.recordFile('src/main.mjs', 'export const main = true;\n');
		assert.equal(draft.files.length, 1, 'one file before clear');

		// Phase 235: clear at heal-turn-start, then the model writes a fix.
		draft.clear();
		assert.equal(draft.isEmpty, true, 'empty after clear');

		draft.recordFile('src/main.mjs', 'export const main = false;\n');
		assert.equal(draft.files.length, 1, 'only the new write captured');
		assert.equal(
			draft.files[0].content,
			'export const main = false;\n',
			'content is the heal turn write, not the stale main-run write',
		);
	});
});

// Phase 241: context-overflow stop reason tests.
// These tests pass context-overflow errors directly from repairTurn to
// exercise healing.mjs's catch-block classification (the retry path lives
// in run-pipeline.mjs's repairTurn wrapper and is exercised separately).
describe('Phase 241: repair_context_overflow stop reason', () => {
	function makeContextOverflowError() {
		const err = new ModelClientError('Context size has been exceeded', {
			status: 400,
		});
		return err;
	}

	it('emits repair_context_overflow when repairTurn throws context-overflow on both calls', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-241-double-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			artifactDir: join(cwd, '.kodr-241-double'),
			maxTurns: 1,
			repairTurn: async () => {
				throw makeContextOverflowError();
			},
			testCommand: 'node --check bad.mjs',
			turnTimeoutMs: 5000,
		});

		assert.equal(
			result.stopReason,
			'repair_context_overflow',
			'stop reason must be repair_context_overflow, not the generic repair_error',
		);
		assert.equal(result.healed, false);
		assert.equal(result.repairs.length, 1);
		assert.equal(result.repairs[0].ok, false);
	});

	it('emits repair_error (not repair_context_overflow) for a non-context-overflow HTTP-400', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-241-other-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 5000,
		});

		const result = await runSelfHealingLoop(cwd, failed, {
			artifactDir: join(cwd, '.kodr-241-other'),
			maxTurns: 1,
			repairTurn: async () => {
				throw new ModelClientError('Bad request: invalid body', {
					status: 400,
				});
			},
			testCommand: 'node --check bad.mjs',
			turnTimeoutMs: 5000,
		});

		assert.equal(
			result.stopReason,
			'repair_error',
			'a 400 without context-overflow message must not be classified as repair_context_overflow',
		);
		assert.equal(result.healed, false);
	});
});

// ---------------------------------------------------------------------------
// Phase 245 — Staged plan in heal repair context
// ---------------------------------------------------------------------------

describe('Phase 245: staged plan in repair context', () => {
	// Test A: buildRepairContext passes through stagedPlan
	it('buildRepairContext includes stagedPlan from options', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-245a-'));
		const context = await buildRepairContext(
			cwd,
			{ ok: false, stdout: '', stderr: '' },
			{ stagedPlan: 'Stage 1: create db.mjs with positional columns r[0]' },
		);
		assert.equal(
			context.stagedPlan,
			'Stage 1: create db.mjs with positional columns r[0]',
		);
	});

	// Test B: renderLoopRepairPrompt includes "Implementation plan" when non-empty
	it('renderLoopRepairPrompt includes Implementation plan section when stagedPlan is present', () => {
		const repairContext = {
			tests: { ok: false, stdout: 'not ok 1 - db query failed', stderr: '' },
			scratchpad: '',
			originalTask: 'Build a kv store',
			stagedPlan:
				'Stage 1: create db.mjs using StatementSync\nStage 2: add routes',
			failurePaths: ['db.mjs'],
			files: [],
			diagnostics: null,
		};
		const prompt = renderLoopRepairPrompt(repairContext, {
			index: 1,
			maxTurns: 3,
		});
		assert.match(prompt, /Implementation plan \(from staged run\)/u);
		assert.match(prompt, /Stage 1: create db\.mjs/u);
	});

	// Test C: renderLoopRepairPrompt omits the plan section when stagedPlan is empty/absent
	it('renderLoopRepairPrompt omits Implementation plan section when stagedPlan is absent', () => {
		const repairContext = {
			tests: { ok: false, stdout: 'not ok 1', stderr: '' },
			scratchpad: '',
			originalTask: 'Fix the bug',
			stagedPlan: '',
			failurePaths: [],
			files: [],
			diagnostics: null,
		};
		const prompt = renderLoopRepairPrompt(repairContext, {
			index: 1,
			maxTurns: 2,
		});
		assert.doesNotMatch(prompt, /Implementation plan/u);

		// Also test absent stagedPlan field (no key at all)
		const repairContextNoKey = {
			tests: { ok: false, stdout: 'not ok 1', stderr: '' },
			scratchpad: '',
			originalTask: '',
			failurePaths: [],
			files: [],
			diagnostics: null,
		};
		const promptNoKey = renderLoopRepairPrompt(repairContextNoKey, {
			index: 1,
			maxTurns: 2,
		});
		assert.doesNotMatch(promptNoKey, /Implementation plan/u);
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
