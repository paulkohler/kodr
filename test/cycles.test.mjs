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
});
