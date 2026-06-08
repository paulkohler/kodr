import { createRunArtifacts } from './artifacts.mjs';
import { buildWorkspaceContext } from './context-packer.mjs';
import { createLoopBudget } from './loop-budgets.mjs';
import {
	createInspectionTaskPlan,
	renderInspectionTaskPlan,
} from './task-plan.mjs';

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
	const inspectionPlan =
		options.inspectionPlan ||
		(options.inspectionIndex
			? createInspectionTaskPlan(options.task || '', options.inspectionIndex)
			: null);
	let scratchpad = options.scratchpad || '';

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
			inspectionPlan,
			priorScratchpad: scratchpad,
			runDir,
			workflowHandoff: renderWorkflowHandoff({
				inspectionPlan,
				scratchpad,
			}),
		});
		scratchpad = extractScratchpad(result) || scratchpad;
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

export function renderWorkflowHandoff({
	inspectionPlan = null,
	scratchpad = '',
}) {
	const parts = [];
	const renderedPlan = inspectionPlan
		? renderInspectionTaskPlan(inspectionPlan)
		: '';
	if (renderedPlan) {
		parts.push(renderedPlan);
	}
	if (scratchpad) {
		parts.push(`## Prior scratchpad\n${scratchpad}`);
	}
	return parts.join('\n\n');
}

function extractScratchpad(result) {
	return result?.scratchpad || result?.proposal?.scratchpad || '';
}

export function hasStopMarker(text) {
	return STOP_MARKERS.some((marker) => text.includes(marker));
}
