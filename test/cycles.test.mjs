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
		assert.equal(hasStopMarker('KODR_STOP'), true);
	});
});
