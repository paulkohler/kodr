import { createRunArtifacts } from './artifacts.mjs';
import { buildWorkspaceContext } from './context-packer.mjs';
import { createLoopBudget } from './loop-budgets.mjs';

const STOP_MARKERS = ['DONE', 'NO_CHANGES', 'KODR_STOP'];

export async function runCycles(cwd, options) {
	const maxCycles = options.cycles;
	const budget = createLoopBudget({
		maxTurns: maxCycles,
		maxTokens: options.maxTokens,
		maxCostUsd: options.maxCostUsd,
	});
	const cycle = options.cycle;
	const results = [];

	for (let index = 1; index <= maxCycles; index += 1) {
		budget.beforeTurn();
		const runDir = await createRunArtifacts(
			cwd,
			`${options.out || '.kodr/runs'}/cycle-${index}`,
		);
		const context = await buildWorkspaceContext(cwd);
		const result = await cycle({
			context,
			index,
			runDir,
		});
		results.push({
			...result,
			budget: budget.recordUsage(result.usage),
			index,
			runDir,
		});

		if (hasStopMarker(result.text || '')) {
			budget.stop('stop_marker');
			break;
		}
	}
	if (!budget.snapshot().stopReason) {
		budget.stop('max_turns');
	}

	return {
		budget: budget.snapshot(),
		cycles: results,
		stoppedEarly:
			hasStopMarker(results.at(-1)?.text || '') && results.length < maxCycles,
	};
}

export function hasStopMarker(text) {
	return STOP_MARKERS.some((marker) => text.includes(marker));
}
