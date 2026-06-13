import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	classifyRunFailure,
	computeComparison,
	computeTrends,
	loadRunSummaries,
	renderComparisonCli,
	renderTrendsCli,
	renderTrendsHtml,
	windowSummaries,
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

	it('aggregates extractor repair frequency and merged-extraction count (phase 128)', () => {
		const r = computeTrends([
			{
				runId: 'r1',
				summary: {
					ok: true,
					extraction: {
						merged: true,
						proposalCount: 2,
						repairs: [{ ruleId: 'gpt-oss-missing-brace', count: 1 }],
					},
				},
			},
			{
				runId: 'r2',
				summary: {
					ok: true,
					extraction: {
						merged: false,
						proposalCount: 1,
						repairs: [
							{ ruleId: 'gpt-oss-missing-brace', count: 1 },
							{ ruleId: 'blanket-quote-token', count: 2 },
						],
					},
				},
			},
			{ runId: 'r3', summary: { ok: true } },
		]);
		assert.equal(r.mergedExtractionCount, 1);
		assert.equal(r.extractorRepairs['gpt-oss-missing-brace'], 2);
		assert.equal(r.extractorRepairs['blanket-quote-token'], 2);
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

describe('windowing (phase 129)', () => {
	const s = (id) => ({ runId: id, summary: { ok: id !== 'r2' } });
	const all = [s('r1'), s('r2'), s('r3'), s('r4'), s('r5')];

	it('splits before/window by --since (runId >= since)', () => {
		const { before, window } = windowSummaries(all, { since: 'r3' });
		assert.deepEqual(
			before.map((x) => x.runId),
			['r1', 'r2'],
		);
		assert.deepEqual(
			window.map((x) => x.runId),
			['r3', 'r4', 'r5'],
		);
	});

	it('keeps the last N and moves the rest to before with --last', () => {
		const { before, window } = windowSummaries(all, { last: 2 });
		assert.deepEqual(
			window.map((x) => x.runId),
			['r4', 'r5'],
		);
		assert.deepEqual(
			before.map((x) => x.runId),
			['r1', 'r2', 'r3'],
		);
	});

	it('no window options keeps everything in window', () => {
		const { before, window } = windowSummaries(all, {});
		assert.equal(before.length, 0);
		assert.equal(window.length, 5);
	});

	it('computeComparison reports before/after ok-rate and delta', () => {
		const before = computeTrends([s('r1'), s('r2')]); // 1/2 ok = 0.5
		const after = computeTrends([s('r3'), s('r4'), s('r5')]); // 3/3 ok = 1.0
		const cmp = computeComparison(before, after);
		assert.equal(cmp.beforeRuns, 2);
		assert.equal(cmp.afterRuns, 3);
		assert.equal(cmp.beforeOkRate, 0.5);
		assert.equal(cmp.afterOkRate, 1);
		assert.equal(cmp.okRateDelta, 0.5);
	});

	it('renderComparisonCli shows the before→after line with delta', () => {
		const out = renderComparisonCli({
			beforeRuns: 2,
			afterRuns: 3,
			beforeOkRate: 0.5,
			afterOkRate: 1,
			okRateDelta: 0.5,
		});
		assert.match(out, /before 50% \(2 runs\) → after 100% \(3 runs\)/u);
		assert.match(out, /\+50pts/u);
	});

	it('renderComparisonCli handles no prior runs', () => {
		const out = renderComparisonCli({
			beforeRuns: 0,
			afterRuns: 4,
			beforeOkRate: 0,
			afterOkRate: 1,
			okRateDelta: 1,
		});
		assert.match(out, /no prior runs/u);
	});
});

describe('renderTrendsHtml (phase 132)', () => {
	it('renders a self-contained dashboard with counts and per-model rows', () => {
		const html = renderTrendsHtml(
			computeTrends([
				{
					runId: 'r1',
					summary: { ok: true, model: 'qwen', proposalFound: true },
				},
				{
					runId: 'r2',
					summary: { ok: false, tested: true, model: 'nemotron' },
				},
			]),
		);
		assert.match(html, /<!DOCTYPE html>/u);
		assert.match(html, /Kodr trends — 2 runs/u);
		assert.match(html, /qwen/u);
		assert.match(html, /nemotron/u);
		assert.match(html, /verification-failed/u);
		// self-contained: no external resource references
		assert.doesNotMatch(html, /<script|src=|href=/u);
	});

	it('includes the before/after comparison when provided', () => {
		const report = computeTrends([{ runId: 'r2', summary: { ok: true } }]);
		const html = renderTrendsHtml(report, {
			beforeRuns: 4,
			afterRuns: 1,
			beforeOkRate: 0.5,
			afterOkRate: 1,
			okRateDelta: 0.5,
		});
		assert.match(html, /before <b>50%<\/b>/u);
		assert.match(html, /after <b>100%<\/b>/u);
	});

	it('escapes HTML-special characters in model names', () => {
		const html = renderTrendsHtml(
			computeTrends([{ runId: 'r1', summary: { ok: true, model: 'a<b>&"x' } }]),
		);
		assert.match(html, /a&lt;b&gt;&amp;&quot;x/u);
		assert.doesNotMatch(html, /a<b>&"x/u);
	});

	it('renders an empty-archive page', () => {
		assert.match(renderTrendsHtml(computeTrends([])), /No runs found/u);
	});
});
