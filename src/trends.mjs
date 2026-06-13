// trends.mjs — cross-run forensics over the .kodr/runs archive (phase 127).
//
// `kodr why` (phase 106) explains one run. `kodr trends` aggregates the whole
// archive into a feedback instrument: how often runs land, which pipeline step
// fails most, whether healing converges, per-model ok-rate. It reads only the
// summary.json each run already writes — no new artifacts, Node 24 built-ins.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Load every parseable summary.json under runsDir. Tolerant: a missing or
// invalid summary is skipped, never fatal — the archive accretes over time and
// partial/aborted runs are normal.
export async function loadRunSummaries(runsDir) {
	let entries;
	try {
		entries = await readdir(runsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const summaries = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runId = entry.name;
		try {
			const raw = await readFile(join(runsDir, runId, 'summary.json'), 'utf8');
			const summary = JSON.parse(raw);
			summaries.push({ runId, summary });
		} catch {
			// No summary, unreadable, or invalid JSON — skip.
		}
	}
	// Run ids are ISO timestamps; sort ascending so "latest" is deterministic.
	summaries.sort((a, b) => a.runId.localeCompare(b.runId));
	return summaries;
}

// Phase 129: window the summaries. `since` keeps runs with runId >= since (run
// ids are ISO timestamps, lexicographically ordered); `last` keeps the most
// recent N. Returns { window, before } so callers can compare after-vs-before.
export function windowSummaries(summaries, { since = '', last = 0 } = {}) {
	let before = [];
	let window = summaries;
	if (since) {
		before = summaries.filter((s) => s.runId < since);
		window = summaries.filter((s) => s.runId >= since);
	}
	if (last && last > 0) {
		const cut = Math.max(0, window.length - last);
		before = before.concat(window.slice(0, cut));
		window = window.slice(cut);
	}
	return { before, window };
}

// Compare two computed reports' ok-rates (before → after). Phase 129: makes the
// "did this change move the needle?" question first-class in one invocation.
export function computeComparison(beforeReport, afterReport) {
	return {
		beforeRuns: beforeReport.totalRuns,
		afterRuns: afterReport.totalRuns,
		beforeOkRate: beforeReport.okRate,
		afterOkRate: afterReport.okRate,
		okRateDelta: afterReport.okRate - beforeReport.okRate,
	};
}

// Classify the dominant failure step for a single failed run. Ordered by where
// the pipeline breaks earliest, so each failed run is attributed once.
export function classifyRunFailure(summary) {
	if (summary.ok === true) return null;
	if (summary.proposalFound === false) return 'no-proposal';
	if (summary.writeError) return 'write-error';
	if (summary.healStopReason === 'nothing-generated')
		return 'nothing-generated';
	if (summary.healStopReason === 'wrong_path_exhausted') return 'wrong-path';
	// Verification ran (or was configured) but the run is not ok.
	if (summary.tested === true) return 'verification-failed';
	if (summary.healStopReason === 'max_turns') return 'heal-exhausted';
	return 'other';
}

function rate(count, total) {
	return total > 0 ? count / total : 0;
}

// Aggregate a list of { runId, summary } into a trends report.
export function computeTrends(summaries) {
	const total = summaries.length;
	const report = {
		totalRuns: total,
		okCount: 0,
		okRate: 0,
		proposalFoundCount: 0,
		appliedCount: 0,
		testedCount: 0,
		healedCount: 0,
		failureSteps: {},
		healStopReasons: {},
		models: {},
		// Phase 128: how often each extractor repair rule fired across runs — which
		// corruption the local models hit most. Empty when no run needed repairs.
		extractorRepairs: {},
		mergedExtractionCount: 0,
		// Phase 130: heals flagged as suspected goal-substitution across the window.
		goalSubstitutionSuspectedCount: 0,
		firstTokenRetries: 0,
		avgPromptTokens: null,
		avgCompletionTokens: null,
		firstRunId: total > 0 ? summaries[0].runId : null,
		lastRunId: total > 0 ? summaries[total - 1].runId : null,
	};

	let promptTokenSum = 0;
	let promptTokenRuns = 0;
	let completionTokenSum = 0;
	let completionTokenRuns = 0;

	for (const { summary } of summaries) {
		if (summary.ok === true) report.okCount += 1;
		if (summary.proposalFound === true) report.proposalFoundCount += 1;
		if (summary.applied === true) report.appliedCount += 1;
		if (summary.tested === true) report.testedCount += 1;
		if (summary.healed === true) report.healedCount += 1;
		if (summary.goalSubstitutionSuspected === true) {
			report.goalSubstitutionSuspectedCount += 1;
		}

		const failStep = classifyRunFailure(summary);
		if (failStep) {
			report.failureSteps[failStep] = (report.failureSteps[failStep] || 0) + 1;
		}

		if (summary.healStopReason) {
			report.healStopReasons[summary.healStopReason] =
				(report.healStopReasons[summary.healStopReason] || 0) + 1;
		}

		const model = summary.model || 'unknown';
		const m = report.models[model] || { runs: 0, ok: 0 };
		m.runs += 1;
		if (summary.ok === true) m.ok += 1;
		report.models[model] = m;

		report.firstTokenRetries += summary.transport?.firstTokenRetries || 0;

		// Phase 128: aggregate extractor repair frequency from summary.extraction.
		if (summary.extraction?.merged === true) {
			report.mergedExtractionCount += 1;
		}
		for (const repair of summary.extraction?.repairs || []) {
			report.extractorRepairs[repair.ruleId] =
				(report.extractorRepairs[repair.ruleId] || 0) + (repair.count || 1);
		}

		const promptTokens = summary.usage?.prompt_tokens;
		if (typeof promptTokens === 'number') {
			promptTokenSum += promptTokens;
			promptTokenRuns += 1;
		}
		const completionTokens = summary.usage?.completion_tokens;
		if (typeof completionTokens === 'number') {
			completionTokenSum += completionTokens;
			completionTokenRuns += 1;
		}
	}

	report.okRate = rate(report.okCount, total);
	report.proposalFoundRate = rate(report.proposalFoundCount, total);
	report.appliedRate = rate(report.appliedCount, total);
	if (promptTokenRuns > 0) {
		report.avgPromptTokens = Math.round(promptTokenSum / promptTokenRuns);
	}
	if (completionTokenRuns > 0) {
		report.avgCompletionTokens = Math.round(
			completionTokenSum / completionTokenRuns,
		);
	}
	for (const model of Object.keys(report.models)) {
		const m = report.models[model];
		m.okRate = rate(m.ok, m.runs);
	}

	return report;
}

function pct(value) {
	return `${Math.round(value * 100)}%`;
}

// Render a compact human-readable report.
export function renderTrendsCli(report) {
	if (report.totalRuns === 0) {
		return 'No runs found under .kodr/runs.\n';
	}
	const lines = [];
	lines.push(`Cross-run trends — ${report.totalRuns} runs`);
	lines.push(`  range: ${report.firstRunId} … ${report.lastRunId}`);
	lines.push('');
	lines.push(
		`  ok           ${report.okCount}/${report.totalRuns} (${pct(report.okRate)})`,
	);
	lines.push(
		`  proposal     ${report.proposalFoundCount}/${report.totalRuns} (${pct(report.proposalFoundRate)})`,
	);
	lines.push(
		`  applied      ${report.appliedCount}/${report.totalRuns} (${pct(report.appliedRate)})`,
	);
	lines.push(`  tested       ${report.testedCount}`);
	lines.push(`  healed       ${report.healedCount}`);
	if (report.goalSubstitutionSuspectedCount > 0) {
		lines.push(
			`  ⚠ suspected goal-substitution heals: ${report.goalSubstitutionSuspectedCount}`,
		);
	}

	const failSteps = Object.entries(report.failureSteps).sort(
		(a, b) => b[1] - a[1],
	);
	if (failSteps.length > 0) {
		lines.push('');
		lines.push('  failures by step:');
		for (const [step, count] of failSteps) {
			lines.push(`    ${step.padEnd(20)} ${count}`);
		}
	}

	const models = Object.entries(report.models).sort(
		(a, b) => b[1].runs - a[1].runs,
	);
	if (models.length > 0) {
		lines.push('');
		lines.push('  by model:');
		for (const [model, m] of models) {
			lines.push(
				`    ${model.padEnd(34)} ${m.ok}/${m.runs} ok (${pct(m.okRate)})`,
			);
		}
	}

	const repairs = Object.entries(report.extractorRepairs).sort(
		(a, b) => b[1] - a[1],
	);
	if (repairs.length > 0 || report.mergedExtractionCount > 0) {
		lines.push('');
		lines.push('  extraction:');
		if (report.mergedExtractionCount > 0) {
			lines.push(`    multi-block assembled  ${report.mergedExtractionCount}`);
		}
		for (const [ruleId, count] of repairs) {
			lines.push(`    ${ruleId.padEnd(26)} ${count}`);
		}
	}

	if (report.avgPromptTokens != null || report.firstTokenRetries > 0) {
		lines.push('');
		if (report.avgPromptTokens != null) {
			lines.push(
				`  avg tokens   prompt ${report.avgPromptTokens} / completion ${report.avgCompletionTokens ?? '?'}`,
			);
		}
		if (report.firstTokenRetries > 0) {
			lines.push(`  first-token retries (total): ${report.firstTokenRetries}`);
		}
	}

	return `${lines.join('\n')}\n`;
}

// Phase 129: render the before/after ok-rate comparison line.
export function renderComparisonCli(comparison) {
	if (comparison.beforeRuns === 0) {
		return `  (no prior runs to compare against; ${comparison.afterRuns} in window)\n`;
	}
	const arrow = comparison.okRateDelta >= 0 ? '▲' : '▼';
	const deltaPts = Math.round(comparison.okRateDelta * 100);
	const sign = deltaPts >= 0 ? '+' : '';
	return (
		`  ok-rate  before ${pct(comparison.beforeOkRate)} (${comparison.beforeRuns} runs) ` +
		`→ after ${pct(comparison.afterOkRate)} (${comparison.afterRuns} runs)  ` +
		`${arrow} ${sign}${deltaPts}pts\n`
	);
}
