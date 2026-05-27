import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { scanRunHistory } from '../src/run-history.mjs';

async function makeRunDir(cwd, name, summary, evalResults) {
	const runPath = join(cwd, '.kodr', 'runs', name);
	await mkdir(runPath, { recursive: true });
	await writeFile(
		join(runPath, 'summary.json'),
		JSON.stringify(summary, null, 2),
		'utf8',
	);
	if (evalResults !== undefined) {
		await writeFile(
			join(runPath, 'eval-results.json'),
			JSON.stringify(evalResults, null, 2),
			'utf8',
		);
	}
	return runPath;
}

describe('scanRunHistory', () => {
	it('returns empty array when runs dir does not exist', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-'));
		const runs = await scanRunHistory(cwd, 'any-id');
		assert.deepEqual(runs, []);
	});

	it('returns empty array when no runs match the promptId', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-'));
		await makeRunDir(cwd, '2026-01-01T00-00-00.000Z', {
			promptId: 'other-id',
			model: 'qwen/qwen3',
			ok: true,
			finishReasons: ['stop'],
			timestamp: '2026-01-01T00:00:00.000Z',
		});

		const runs = await scanRunHistory(cwd, 'target-id');
		assert.equal(runs.length, 0);
	});

	it('finds runs matching the promptId', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-'));
		await makeRunDir(cwd, '2026-01-01T00-00-01.000Z', {
			promptId: 'todo-cli',
			model: 'qwen/qwen3',
			ok: true,
			finishReasons: ['stop'],
			timestamp: '2026-01-01T00:00:01.000Z',
		});

		const runs = await scanRunHistory(cwd, 'todo-cli');
		assert.equal(runs.length, 1);
		assert.equal(runs[0].model, 'qwen/qwen3');
		assert.equal(runs[0].ok, true);
		assert.deepEqual(runs[0].finishReasons, ['stop']);
		assert.equal(runs[0].evalScore, null);
	});

	it('includes eval score when eval-results.json is present', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-eval-'));
		await makeRunDir(
			cwd,
			'2026-01-01T00-00-02.000Z',
			{
				promptId: 'todo-cli',
				model: 'qwen/qwen3',
				ok: true,
				finishReasons: ['stop'],
				timestamp: '2026-01-01T00:00:02.000Z',
			},
			{
				name: 'todo-cli smoke',
				ok: true,
				score: 0.75,
				passCount: 3,
				totalCount: 4,
			},
		);

		const runs = await scanRunHistory(cwd, 'todo-cli');
		assert.equal(runs.length, 1);
		assert.equal(runs[0].evalScore, 0.75);
	});

	it('sorts runs by run dir name (ascending)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-sort-'));
		const base = {
			promptId: 'my-prompt',
			model: 'm',
			ok: true,
			finishReasons: [],
		};
		await makeRunDir(cwd, '2026-01-01T00-00-03.000Z', {
			...base,
			timestamp: '2026-01-01T00:00:03.000Z',
		});
		await makeRunDir(cwd, '2026-01-01T00-00-01.000Z', {
			...base,
			timestamp: '2026-01-01T00:00:01.000Z',
		});
		await makeRunDir(cwd, '2026-01-01T00-00-02.000Z', {
			...base,
			timestamp: '2026-01-01T00:00:02.000Z',
		});

		const runs = await scanRunHistory(cwd, 'my-prompt');
		assert.equal(runs.length, 3);
		assert.ok(runs[0].runDir < runs[1].runDir);
		assert.ok(runs[1].runDir < runs[2].runDir);
	});

	it('skips dirs without summary.json', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-skip-'));
		const noSummaryPath = join(
			cwd,
			'.kodr',
			'runs',
			'2026-01-01T00-00-00.000Z',
		);
		await mkdir(noSummaryPath, { recursive: true });

		await makeRunDir(cwd, '2026-01-01T00-00-01.000Z', {
			promptId: 'target',
			model: 'm',
			ok: true,
			finishReasons: [],
			timestamp: '2026-01-01T00:00:01.000Z',
		});

		const runs = await scanRunHistory(cwd, 'target');
		assert.equal(runs.length, 1);
	});

	it('uses timestamp from summary.json when present', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-rh-ts-'));
		await makeRunDir(cwd, '2026-01-01T00-00-00.000Z', {
			promptId: 'p',
			model: 'm',
			ok: true,
			finishReasons: [],
			timestamp: '2026-01-01T12:34:56.000Z',
		});

		const runs = await scanRunHistory(cwd, 'p');
		assert.equal(runs[0].timestamp, '2026-01-01T12:34:56.000Z');
	});
});
