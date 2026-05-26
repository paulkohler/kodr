export const TASK_STATUSES = new Set([
	'pending',
	'in_progress',
	'completed',
	'failed',
]);

export class TaskPlanError extends Error {
	constructor(message) {
		super(message);
		this.name = 'TaskPlanError';
	}
}

export function createTaskPlan(task, paths = []) {
	const tasks = [
		createTask(
			'understand-request',
			'Understand the user request',
			'completed',
		),
		createTask('inspect-context', 'Inspect workspace context', 'completed'),
	];

	for (const path of paths) {
		tasks.push(
			createTask(
				`edit-${slugPath(path)}`,
				`Prepare changes for ${path}`,
				'pending',
				{ path },
			),
		);
	}

	tasks.push(createTask('verify', 'Run requested verification', 'pending'));
	tasks.push(createTask('document', 'Update learning artifacts', 'pending'));

	return {
		task,
		tasks,
	};
}

export function updateTask(plan, id, status, note = '') {
	if (!TASK_STATUSES.has(status)) {
		throw new TaskPlanError(`Unknown task status: ${status}`);
	}

	const task = plan.tasks.find((item) => item.id === id);
	if (!task) {
		throw new TaskPlanError(`Unknown task id: ${id}`);
	}

	return {
		...plan,
		tasks: plan.tasks.map((item) => {
			if (item.id !== id) {
				return item;
			}

			return {
				...item,
				note: note || item.note,
				status,
			};
		}),
	};
}

export function updateTasksFromRun(plan, result) {
	let next = plan;

	if (result.proposalFound && !result.writeError) {
		for (const task of next.tasks.filter((item) => item.path)) {
			next = updateTask(
				next,
				task.id,
				'completed',
				'Proposal included this path.',
			);
		}
	}

	if (result.proposalError) {
		next = updateTask(next, 'verify', 'failed', 'Proposal validation failed.');
	}

	if (result.writeError) {
		for (const task of next.tasks.filter((item) => item.path)) {
			next = updateTask(next, task.id, 'failed', result.writeError.message);
		}
		next = updateTask(next, 'verify', 'failed', 'Change preparation failed.');
	}

	if (result.tested) {
		next = updateTask(
			next,
			'verify',
			result.ok ? 'completed' : 'failed',
			result.ok ? 'Verification passed.' : 'Verification failed.',
		);
	}

	return updateTask(
		next,
		'document',
		'completed',
		'Run artifacts were written.',
	);
}

export function taskCounts(plan) {
	return plan.tasks.reduce(
		(counts, task) => {
			counts[task.status] = (counts[task.status] || 0) + 1;
			return counts;
		},
		{
			completed: 0,
			failed: 0,
			in_progress: 0,
			pending: 0,
		},
	);
}

function createTask(id, description, status, extra = {}) {
	return {
		description,
		id,
		status,
		...extra,
	};
}

function slugPath(path) {
	return path
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, '-')
		.replaceAll(/^-|-$/gu, '')
		.slice(0, 80);
}
