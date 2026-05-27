import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compareModels, ReplayError, replayRun } from '../src/replay.mjs';

describe('replay and model comparison', () => {
	it('replays run artifacts without model calls', async () => {
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-replay-'));
		await writeFile(join(runDir, 'prompt.md'), 'prompt', 'utf8');
		await writeFile(join(runDir, 'response.md'), 'response', 'utf8');
		await writeFile(join(runDir, 'summary.json'), '{"ok":true}\n', 'utf8');
		await writeFile(
			join(runDir, 'raw-response.json'),
			'{"responses":[{"id":"1"}]}\n',
			'utf8',
		);

		const replay = await replayRun(runDir);

		assert.equal(replay.prompt, 'prompt');
		assert.equal(replay.response, 'response');
		assert.equal(replay.summary.ok, true);
		assert.equal(replay.raw.responses[0].id, '1');
	});

	it('reports missing and corrupt replay artifacts clearly', async () => {
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-replay-bad-'));
		await writeFile(join(runDir, 'prompt.md'), 'prompt', 'utf8');
		await writeFile(join(runDir, 'response.md'), 'response', 'utf8');
		await writeFile(join(runDir, 'summary.json'), '{nope', 'utf8');

		await assert.rejects(
			() => replayRun(runDir),
			(error) =>
				error instanceof ReplayError &&
				error.message === 'Replay artifact is invalid JSON: summary.json',
		);

		await writeFile(join(runDir, 'summary.json'), '{"ok":true}', 'utf8');
		await assert.rejects(
			() => replayRun(runDir),
			(error) =>
				error instanceof ReplayError &&
				error.message === 'Replay artifact is missing: raw-response.json',
		);
	});

	it('compares at least two fake models and records metadata', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-compare-'));
		await mkdir(join(cwd, 'process'), { recursive: true });
		await writeFile(join(cwd, 'process', 'experiments.jsonl'), '', 'utf8');

		const comparison = await compareModels(
			cwd,
			'prompt',
			['fake-a', 'fake-b'],
			(model, prompt) => {
				return {
					response: `${model}:${prompt}`,
				};
			},
		);

		assert.deepEqual(
			comparison.models.map((model) => model.model),
			['fake-a', 'fake-b'],
		);
		assert.equal(
			JSON.parse(await readFile(join(cwd, '.kodr', 'comparison.json'), 'utf8'))
				.models.length,
			2,
		);
		assert.match(
			await readFile(join(cwd, 'process', 'experiments.jsonl'), 'utf8'),
			/fake-a/u,
		);
	});
});
