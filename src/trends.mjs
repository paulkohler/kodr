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
	if (summary.healStopReason === 'reasoning_runaway')
		return 'reasoning-runaway';
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
		// Phase 169: smoke-check outcomes and sensor warn hit-rates.
		smokeOkCount: 0,
		smokeFailCount: 0,
		smokeSkipCount: 0,
		sensorWarnRuns: 0,
		sensorWarns: {},
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

		// Phase 169: smoke-check outcome tallies.
		const smoke = summary.smokeCheck;
		if (smoke && typeof smoke.status === 'string') {
			if (smoke.status === 'ok') report.smokeOkCount += 1;
			else if (smoke.status === 'failed') report.smokeFailCount += 1;
			else report.smokeSkipCount += 1;
		}

		// Phase 169: per-sensor warn counts across runs.
		const sensors = summary.sensors;
		if (Array.isArray(sensors) && sensors.length > 0) {
			let anyWarn = false;
			for (const sensor of sensors) {
				if (sensor.status === 'warn') {
					anyWarn = true;
					const name = sensor.sensor || 'unknown';
					report.sensorWarns[name] = (report.sensorWarns[name] || 0) + 1;
				}
			}
			if (anyWarn) report.sensorWarnRuns += 1;
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

	const smokeTotal =
		report.smokeOkCount + report.smokeFailCount + report.smokeSkipCount;
	if (smokeTotal > 0) {
		lines.push('');
		lines.push(`  smoke check (${smokeTotal} runs with entry):`);
		lines.push(`    ok       ${report.smokeOkCount}`);
		if (report.smokeFailCount > 0) {
			lines.push(`    failed   ${report.smokeFailCount}`);
		}
		if (report.smokeSkipCount > 0) {
			lines.push(`    skipped  ${report.smokeSkipCount}`);
		}
	}

	const sensorWarnEntries = Object.entries(report.sensorWarns).sort(
		(a, b) => b[1] - a[1],
	);
	if (sensorWarnEntries.length > 0) {
		lines.push('');
		lines.push(`  sensor warns (${report.sensorWarnRuns} runs):`);
		for (const [name, count] of sensorWarnEntries) {
			lines.push(`    ${name.padEnd(24)} ${count}`);
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

function esc(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Phase 132: a self-contained HTML dashboard for the run archive — same
// dependency-free, dark-theme shape as the `kodr why` forensics page (106).
export function renderTrendsHtml(report, comparison = null) {
	if (report.totalRuns === 0) {
		return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kodr trends</title></head><body><p>No runs found under .kodr/runs.</p></body></html>\n';
	}
	const bar = (value) => {
		const w = Math.round(value * 100);
		return `<div class="bar"><div class="fill" style="width:${w}%"></div><span>${w}%</span></div>`;
	};
	const row = (label, count, total, value) =>
		`<tr><td>${esc(label)}</td><td class="num">${count}/${total}</td><td>${bar(value)}</td></tr>`;

	const failRows = Object.entries(report.failureSteps)
		.sort((a, b) => b[1] - a[1])
		.map(
			([step, n]) => `<tr><td>${esc(step)}</td><td class="num">${n}</td></tr>`,
		)
		.join('');
	const modelRows = Object.entries(report.models)
		.sort((a, b) => b[1].runs - a[1].runs)
		.map(
			([m, v]) =>
				`<tr><td>${esc(m)}</td><td class="num">${v.ok}/${v.runs}</td><td>${bar(v.okRate)}</td></tr>`,
		)
		.join('');
	const repairRows = Object.entries(report.extractorRepairs || {})
		.sort((a, b) => b[1] - a[1])
		.map(([id, n]) => `<tr><td>${esc(id)}</td><td class="num">${n}</td></tr>`)
		.join('');

	const comparisonHtml = comparison
		? `<p class="compare">ok-rate before <b>${Math.round(comparison.beforeOkRate * 100)}%</b> (${comparison.beforeRuns}) → after <b>${Math.round(comparison.afterOkRate * 100)}%</b> (${comparison.afterRuns}) — ${comparison.okRateDelta >= 0 ? '▲ +' : '▼ '}${Math.round(comparison.okRateDelta * 100)}pts</p>`
		: '';
	const suspectHtml =
		report.goalSubstitutionSuspectedCount > 0
			? `<p class="warn">⚠ suspected goal-substitution heals: ${report.goalSubstitutionSuspectedCount}</p>`
			: '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kodr trends — ${report.totalRuns} runs</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:ui-monospace,'Cascadia Code',monospace;font-size:13px;background:#0d1117;color:#c9d1d9;padding:24px}
  h1{font-size:16px;color:#e6edf3;margin-bottom:4px}
  h2{font-size:13px;color:#e6edf3;margin:20px 0 8px}
  .meta{color:#8b949e;font-size:12px;margin-bottom:16px}
  table{border-collapse:collapse;width:100%;max-width:680px;margin-bottom:8px}
  td{padding:4px 8px;border-bottom:1px solid #21262d;vertical-align:middle}
  .num{color:#8b949e;text-align:right;white-space:nowrap}
  .bar{position:relative;background:#161b22;border:1px solid #21262d;border-radius:4px;height:16px;min-width:120px}
  .fill{position:absolute;top:0;left:0;height:100%;background:#3fb950;border-radius:4px;opacity:.6}
  .bar span{position:relative;padding-left:6px;font-size:11px;line-height:16px}
  .compare{margin:8px 0;color:#e6edf3}
  .warn{color:#d29922;margin:8px 0}
</style>
</head>
<body>
  <h1>Kodr trends — ${report.totalRuns} runs</h1>
  <div class="meta">${esc(report.firstRunId || '')} … ${esc(report.lastRunId || '')}</div>
  ${comparisonHtml}
  ${suspectHtml}
  <table>
    ${row('ok', report.okCount, report.totalRuns, report.okRate)}
    ${row('proposal', report.proposalFoundCount, report.totalRuns, report.proposalFoundRate)}
    ${row('applied', report.appliedCount, report.totalRuns, report.appliedRate)}
  </table>
  ${failRows ? `<h2>failures by step</h2><table>${failRows}</table>` : ''}
  ${modelRows ? `<h2>by model</h2><table>${modelRows}</table>` : ''}
  ${repairRows ? `<h2>extractor repairs</h2><table>${repairRows}</table>` : ''}
</body>
</html>
`;
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
