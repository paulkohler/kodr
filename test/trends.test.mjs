import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	classifyRunFailure,
	computeTrends,
	loadRunSummaries,
	renderTrendsCli,
} from '../src/trends.mjs';

async function makeRuns(runs) {
	const dir = await mkdtemp(join(tmpdir(), 'kodr-trends-'));
	for (const [runId, summary] of Object.entries(runs)) {
		const runDir = join(dir, runId);
		await mkdir(runDir, { recursive: true });
		if (summary !== null) {
			await writeFile(
				join(runDir, 'summary.json'),
				typeof summary === 'string' ? summary : JSON.stringify(summary),
			);
		}
	}
	return dir;
}

describe('loadRunSummaries', () => {
	it('loads valid summaries and skips missing/invalid ones', async () => {
		const dir = await makeRuns({
			'2026-01-01T00-00-00.000Z': { ok: true, model: 'm' },
			'2026-01-02T00-00-00.000Z': 'not json',
			'2026-01-03T00-00-00.000Z': null, // dir without summary.json
		});
		const summaries = await loadRunSummaries(dir);
		assert.equal(summaries.length, 1);
		assert.equal(summaries[0].runId, '2026-01-01T00-00-00.000Z');
	});

	it('returns [] for a missing runs dir', async () => {
		assert.deepEqual(await loadRunSummaries('/no/such/dir/xyz'), []);
	});

	it('sorts ascending by runId', async () => {
		const dir = await makeRuns({
			'2026-03-01T00-00-00.000Z': { ok: true },
			'2026-01-01T00-00-00.000Z': { ok: true },
			'2026-02-01T00-00-00.000Z': { ok: true },
		});
		const ids = (await loadRunSummaries(dir)).map((s) => s.runId);
		assert.deepEqual(ids, [
			'2026-01-01T00-00-00.000Z',
			'2026-02-01T00-00-00.000Z',
			'2026-03-01T00-00-00.000Z',
		]);
	});
});

describe('classifyRunFailure', () => {
	it('returns null for ok runs', () => {
		assert.equal(classifyRunFailure({ ok: true }), null);
	});
	it('attributes the earliest broken step', () => {
		assert.equal(
			classifyRunFailure({ ok: false, proposalFound: false }),
			'no-proposal',
		);
		assert.equal(
			classifyRunFailure({ ok: false, writeError: { message: 'x' } }),
			'write-error',
		);
		assert.equal(
			classifyRunFailure({ ok: false, healStopReason: 'nothing-generated' }),
			'nothing-generated',
		);
		assert.equal(
			classifyRunFailure({ ok: false, healStopReason: 'wrong_path_exhausted' }),
			'wrong-path',
		);
		assert.equal(
			classifyRunFailure({ ok: false, tested: true }),
			'verification-failed',
		);
		assert.equal(
			classifyRunFailure({ ok: false, healStopReason: 'max_turns' }),
			'heal-exhausted',
		);
		assert.equal(classifyRunFailure({ ok: false }), 'other');
	});
});

describe('computeTrends', () => {
	it('aggregates rates, failure steps, per-model ok-rate, and token averages', async () => {
		const summaries = [
			{
				runId: 'r1',
				summary: {
					ok: true,
					proposalFound: true,
					applied: true,
					tested: true,
					model: 'a',
					usage: { prompt_tokens: 100, completion_tokens: 20 },
				},
			},
			{
				runId: 'r2',
				summary: {
					ok: false,
					proposalFound: false,
					model: 'a',
					transport: { firstTokenRetries: 1 },
				},
			},
			{
				runId: 'r3',
				summary: {
					ok: false,
					proposalFound: true,
					tested: true,
					model: 'b',
					usage: { prompt_tokens: 300, completion_tokens: 40 },
				},
			},
		];
		const r = computeTrends(summaries);
		assert.equal(r.totalRuns, 3);
		assert.equal(r.okCount, 1);
		assert.equal(Math.round(r.okRate * 100), 33);
		assert.equal(r.proposalFoundCount, 2);
		assert.equal(r.appliedCount, 1);
		assert.deepEqual(r.failureSteps, {
			'no-proposal': 1,
			'verification-failed': 1,
		});
		assert.equal(r.models.a.runs, 2);
		assert.equal(r.models.a.ok, 1);
		assert.equal(r.models.b.okRate, 0);
		assert.equal(r.firstTokenRetries, 1);
		assert.equal(r.avgPromptTokens, 200);
		assert.equal(r.avgCompletionTokens, 30);
		assert.equal(r.firstRunId, 'r1');
		assert.equal(r.lastRunId, 'r3');
	});

	it('handles an empty archive', () => {
		const r = computeTrends([]);
		assert.equal(r.totalRuns, 0);
		assert.equal(r.okRate, 0);
		assert.equal(r.avgPromptTokens, null);
	});
});

describe('renderTrendsCli', () => {
	it('renders an empty-archive message', () => {
		assert.match(renderTrendsCli(computeTrends([])), /No runs found/u);
	});
	it('renders counts, failure steps, and per-model lines', () => {
		const out = renderTrendsCli(
			computeTrends([
				{ runId: 'r1', summary: { ok: true, model: 'a' } },
				{ runId: 'r2', summary: { ok: false, tested: true, model: 'a' } },
			]),
		);
		assert.match(out, /Cross-run trends — 2 runs/u);
		assert.match(out, /ok\s+1\/2 \(50%\)/u);
		assert.match(out, /verification-failed/u);
		assert.match(out, /a\s+1\/2 ok \(50%\)/u);
	});
});
