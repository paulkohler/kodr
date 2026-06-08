import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hasStopMarker, runCycles } from '../src/cycles.mjs';

describe('continuous cycles', () => {
	it('runs multiple bounded cycles with fresh context', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycles-'));
		await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');

		const result = await runCycles(cwd, {
			cycles: 3,
			cycle({ context, index }) {
				return {
					fileCount: context.files.length,
					text: `cycle ${index}`,
				};
			},
		});

		assert.equal(result.cycles.length, 3);
		assert.equal(result.budget.stopReason, 'max_turns');
		assert.equal(result.budget.turns, 3);
		assert.deepEqual(
			result.cycles.map((cycle) => cycle.fileCount),
			[1, 1, 1],
		);
		assert.equal(result.stoppedEarly, false);
	});

	it('stops early on explicit markers', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycles-stop-'));
		const result = await runCycles(cwd, {
			cycles: 5,
			cycle({ index }) {
				return {
					text: index === 2 ? 'NO_CHANGES' : 'keep going',
				};
			},
		});

		assert.equal(result.cycles.length, 2);
		assert.equal(result.stoppedEarly, true);
		assert.equal(result.budget.stopReason, 'stop_marker');
		assert.equal(hasStopMarker('KODR_STOP'), true);
	});

	it('records cycle token usage against the loop budget', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycles-budget-'));
		const result = await runCycles(cwd, {
			cycles: 2,
			maxTokens: 10,
			cycle({ index }) {
				return {
					text: `cycle ${index}`,
					usage: { total_tokens: index },
				};
			},
		});

		assert.equal(result.budget.tokens, 3);
		assert.equal(result.cycles[1].budget.tokens, 3);
	});

	it('forwards inspection plan and scratchpad across cycle turns', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycles-forward-'));
		const observed = [];
		const result = await runCycles(cwd, {
			cycles: 2,
			inspectionIndex: {
				rankedSymbols: [],
				symbols: [
					{
						kind: 'function',
						lineEnd: 3,
						lineStart: 1,
						name: 'runPrompt',
						path: 'src/app.mjs',
					},
				],
			},
			task: 'change runPrompt',
			cycle({ index, inspectionPlan, priorScratchpad, workflowHandoff }) {
				observed.push({
					hasPlan:
						inspectionPlan.inspection.targetFiles.includes('src/app.mjs'),
					index,
					priorScratchpad,
					workflowHandoff,
				});
				return {
					scratchpad: index === 1 ? 'next: patch app' : '',
					text: `cycle ${index}`,
				};
			},
		});

		assert.equal(result.cycles.length, 2);
		assert.equal(observed[0].hasPlan, true);
		assert.equal(observed[0].priorScratchpad, '');
		assert.match(observed[0].workflowHandoff, /Inspection-derived plan/u);
		assert.equal(observed[1].priorScratchpad, 'next: patch app');
		assert.match(observed[1].workflowHandoff, /Prior scratchpad/u);
		assert.match(observed[1].workflowHandoff, /next: patch app/u);
	});
});
