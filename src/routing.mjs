// routing.mjs — recommend a model from run-history ok-rate (phase 131).
//
// Phases 127/129 made per-model ok-rate available and windowable. This turns
// that retrospective signal into an actionable recommendation: of the models you
// have actually run enough times, which lands edits most often. Advisory by
// default; `kodr route --apply` writes it into .kodr/config.json.

// Rank the models in a trends report by ok-rate (runs as tiebreak), keeping only
// those with at least minRuns runs so a lucky 1/1 doesn't outrank a solid 14/21.
// Returns { recommended, ranked, minRuns, eligibleCount, totalModels }.
export function recommendModel(report, { minRuns = 3 } = {}) {
	const models = report?.models || {};
	const ranked = Object.entries(models)
		.map(([model, m]) => ({
			model,
			runs: m.runs,
			ok: m.ok,
			okRate: m.okRate ?? (m.runs > 0 ? m.ok / m.runs : 0),
		}))
		.filter((m) => m.model !== 'unknown' && m.runs >= minRuns)
		.sort((a, b) => b.okRate - a.okRate || b.runs - a.runs);
	return {
		recommended: ranked.length > 0 ? ranked[0].model : null,
		ranked,
		minRuns,
		eligibleCount: ranked.length,
		totalModels: Object.keys(models).length,
	};
}

function pct(value) {
	return `${Math.round(value * 100)}%`;
}

export function renderRouteCli(rec, { applied = false } = {}) {
	if (rec.recommended === null) {
		return (
			`No model has at least ${rec.minRuns} runs in the archive ` +
			`(${rec.totalModels} model${rec.totalModels === 1 ? '' : 's'} seen). ` +
			'Run more, or lower --min-runs.\n'
		);
	}
	const lines = [];
	lines.push(
		`Recommended edit model (by run-history ok-rate, ≥${rec.minRuns} runs):`,
	);
	lines.push(`  → ${rec.recommended}`);
	lines.push('');
	lines.push('  candidates:');
	for (const m of rec.ranked) {
		const star = m.model === rec.recommended ? ' *' : '';
		lines.push(
			`    ${m.model.padEnd(34)} ${m.ok}/${m.runs} ok (${pct(m.okRate)})${star}`,
		);
	}
	if (applied) {
		lines.push('');
		lines.push(
			`  applied: model set to ${rec.recommended} in .kodr/config.json`,
		);
	}
	return `${lines.join('\n')}\n`;
}
