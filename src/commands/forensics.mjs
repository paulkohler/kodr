// commands/forensics.mjs — run-history forensics & routing CLI commands.
// Extracted from app.mjs main() in phase 148 (app split). Each handler keeps
// its exact (options, io) → result contract; bodies are verbatim moves.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	buildCausalStory,
	loadRunAnalysis,
	renderForensicsCli,
	resolveRunDir,
} from '../forensics.mjs';

export async function runWhy(options, io) {
	const runDir = await resolveRunDir(io.cwd, options.whyRunId || '');
	const analysis = await loadRunAnalysis(runDir);
	const story = buildCausalStory(analysis);
	if (options.json) {
		io.stdout.write(
			`${JSON.stringify({ analysis: { ...analysis, contextMd: undefined, promptMd: undefined, responseMd: undefined }, runDir, story }, null, 2)}\n`,
		);
	} else {
		io.stdout.write(renderForensicsCli(analysis, story));
	}
	return { command: 'why', ok: true, runDir, story };
}

export async function runTrends(options, io) {
	const {
		computeComparison,
		computeTrends,
		loadRunSummaries,
		renderComparisonCli,
		renderTrendsCli,
		renderTrendsHtml,
		windowSummaries,
	} = await import('../trends.mjs');
	const runsDir = options.runsDir
		? options.runsDir.startsWith('/')
			? options.runsDir
			: join(io.cwd, options.runsDir)
		: join(io.cwd, '.kodr', 'runs');
	const all = await loadRunSummaries(runsDir);
	const windowed =
		options.trendsSince || options.trendsLast
			? windowSummaries(all, {
					since: options.trendsSince || '',
					last: options.trendsLast || 0,
				})
			: { before: [], window: all };
	const report = computeTrends(windowed.window);
	const comparison =
		windowed.before.length > 0
			? computeComparison(computeTrends(windowed.before), report)
			: null;
	if (options.trendsHtml) {
		io.stdout.write(renderTrendsHtml(report, comparison));
	} else if (options.json) {
		io.stdout.write(
			`${JSON.stringify({ report, ...(comparison ? { comparison } : {}) }, null, 2)}\n`,
		);
	} else {
		io.stdout.write(renderTrendsCli(report));
		if (comparison) {
			io.stdout.write(`\n${renderComparisonCli(comparison)}`);
		}
	}
	return { command: 'trends', ok: true, comparison, report, runsDir };
}

export async function runRoute(options, io) {
	const { computeTrends, loadRunSummaries } = await import('../trends.mjs');
	const { recommendModel, renderRouteCli } = await import('../routing.mjs');
	const runsDir = options.runsDir
		? options.runsDir.startsWith('/')
			? options.runsDir
			: join(io.cwd, options.runsDir)
		: join(io.cwd, '.kodr', 'runs');
	const report = computeTrends(await loadRunSummaries(runsDir));
	const minRuns = options.routeMinRuns > 0 ? options.routeMinRuns : 3;
	const rec = recommendModel(report, { minRuns });
	let applied = false;
	if (options.routeApply && rec.recommended) {
		await applyRecommendedModel(io.cwd, rec.recommended);
		applied = true;
	}
	if (options.json) {
		io.stdout.write(`${JSON.stringify({ ...rec, applied }, null, 2)}\n`);
	} else {
		io.stdout.write(renderRouteCli(rec, { applied }));
	}
	return { command: 'route', ok: true, recommendation: rec, applied };
}

export async function runEvals(options, io) {
	const { loadEvalResults, renderEvalTrendsCli, summarizeEvalResults } =
		await import('../eval-trends.mjs');
	const evalsResultsDir = options.runsDir
		? options.runsDir.startsWith('/')
			? options.runsDir
			: join(io.cwd, options.runsDir)
		: join(io.cwd, 'evals', 'results');
	const pairs = summarizeEvalResults(await loadEvalResults(evalsResultsDir));
	if (options.json) {
		io.stdout.write(`${JSON.stringify(pairs, null, 2)}\n`);
	} else {
		io.stdout.write(renderEvalTrendsCli(pairs));
	}
	return { command: 'evals', ok: true, pairs };
}

// Used by `route --apply`: persist the recommended model into .kodr/config.json.
async function applyRecommendedModel(cwd, model) {
	const configPath = join(cwd, '.kodr/config.json');
	let config = {};
	try {
		config = JSON.parse(await readFile(configPath, 'utf8'));
		if (!config || typeof config !== 'object' || Array.isArray(config)) {
			config = {};
		}
	} catch {
		config = {};
	}
	config.model = model;
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
