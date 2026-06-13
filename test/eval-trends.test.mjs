import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	loadEvalResults,
	renderEvalTrendsCli,
	sparkline,
	summarizeEvalResults,
} from '../src/eval-trends.mjs';

async function makeResults(tree) {
	const dir = await mkdtemp(join(tmpdir(), 'kodr-evaltrends-'));
	for (const [suite, files] of Object.entries(tree)) {
		const suiteDir = join(dir, suite);
		await mkdir(suiteDir, { recursive: true });
		for (const [file, lines] of Object.entries(files)) {
			const body = lines
				.map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
				.join('\n');
			await writeFile(join(suiteDir, file), `${body}\n`);
		}
	}
	return dir;
}

describe('loadEvalResults', () => {
	it('loads parseable result lines and skips junk', async () => {
		const dir = await makeResults({
			brownfield: {
				'model-a.jsonl': [
					{ suiteName: 'brownfield', model: 'a', score: 0.5, timestamp: '1' },
					'not json',
					{ suiteName: 'brownfield', model: 'a', score: 0.75, timestamp: '2' },
				],
			},
		});
		const results = await loadEvalResults(dir);
		assert.equal(results.length, 2);
	});

	it('returns [] for a missing dir', async () => {
		assert.deepEqual(await loadEvalResults('/no/such/evals/xyz'), []);
	});
});

describe('summarizeEvalResults', () => {
	it('groups by suite+model, ordered by timestamp, with latest/delta/best/worst', () => {
		const pairs = summarizeEvalResults([
			{
				suiteName: 's',
				model: 'a',
				score: 0.4,
				timestamp: '1',
				passCount: 2,
				totalCount: 5,
			},
			{
				suiteName: 's',
				model: 'a',
				score: 0.8,
				timestamp: '2',
				passCount: 4,
				totalCount: 5,
			},
			{ suiteName: 's', model: 'b', score: 1, timestamp: '1' },
		]);
		assert.equal(pairs.length, 2);
		const a = pairs.find((p) => p.model === 'a');
		assert.equal(a.runs, 2);
		assert.equal(a.latestScore, 0.8);
		assert.equal(a.firstScore, 0.4);
		assert.ok(Math.abs(a.delta - 0.4) < 1e-9);
		assert.equal(a.bestScore, 0.8);
		assert.equal(a.worstScore, 0.4);
		assert.equal(a.latestPassCount, 4);
	});
});

describe('sparkline', () => {
	it('maps scores 0..1 to block glyphs', () => {
		const s = sparkline([0, 0.5, 1]);
		assert.equal(s.length, 3);
		assert.equal(s[0], '▁');
		assert.equal(s[2], '█');
	});
});

describe('renderEvalTrendsCli', () => {
	it('renders an empty message when there are no results', () => {
		assert.match(renderEvalTrendsCli([]), /No eval results found/u);
	});
	it('renders suite headers, latest score, run count, and trend', () => {
		const out = renderEvalTrendsCli(
			summarizeEvalResults([
				{ suiteName: 's', model: 'a', score: 0.4, timestamp: '1' },
				{ suiteName: 's', model: 'a', score: 1, timestamp: '2' },
			]),
		);
		assert.match(out, /Eval score trends/u);
		assert.match(out, /100% latest \(2 runs\)/u);
		assert.match(out, /\+60pts/u);
	});
});
