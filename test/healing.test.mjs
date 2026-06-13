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
	HealingTimeoutError,
	isNothingGenerated,
	oneShotHeal,
	renderEscalationPrompt,
	renderWrongPathWarning,
	runSelfHealingLoop,
	writesReferenceTask,
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
