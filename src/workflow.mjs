import { createTaskPlan } from './task-plan.mjs';

export const WORKFLOW_STAGES = [
	'Planner',
	'Coder',
	'Senior Reviewer',
	'Writer',
	'Tester',
	'Documenter',
	'Reporter',
];

export function createWorkflowPlan(task, proposedFiles = []) {
	const proposedPaths = proposedFiles.map((file) => file.path);

	return {
		proposedPaths,
		stages: WORKFLOW_STAGES.map((name) => ({
			name,
			status: 'pending',
		})),
		task,
		tasks: createTaskPlan(task, proposedPaths).tasks,
	};
}

export function reviewWorkflowProposal(plan, proposal) {
	const proposalPaths = new Set(proposal.files.map((file) => file.path));
	const plannedPaths = new Set(plan.proposedPaths);
	const unplanned = [...proposalPaths].filter(
		(path) => !plannedPaths.has(path),
	);

	if (unplanned.length > 0) {
		return {
			ok: false,
			reason: `Proposal touches unplanned paths: ${unplanned.join(', ')}`,
			unplanned,
		};
	}

	return {
		ok: true,
		reason: 'Proposal paths match the reviewed plan.',
		unplanned: [],
	};
}

export function runWorkflow(task, proposal) {
	const plan = createWorkflowPlan(task, proposal.files);
	const review = reviewWorkflowProposal(plan, proposal);

	return {
		plan,
		review,
		report: {
			ok: review.ok,
			stages: WORKFLOW_STAGES,
			summary: review.ok
				? 'Workflow proposal approved.'
				: 'Workflow proposal rejected.',
		},
	};
}
