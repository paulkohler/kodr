import { parseVerificationCommand } from './verification-runner.mjs';

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

export function createInspectionTaskPlan(task, index, options = {}) {
	const targetSymbols = selectTargetSymbols(
		task,
		index,
		options.maxSymbols || 10,
	);
	const targetFiles = selectTargetFiles(
		targetSymbols,
		index,
		options.maxFiles || 8,
	);
	const relatedTests = selectRelatedTests(index, targetFiles);
	const suggestedVerificationCommands = suggestVerificationCommands(
		targetFiles,
		relatedTests,
	);
	const riskNotes = [];
	if (targetSymbols.length === 0) {
		riskNotes.push(
			'No directly matching symbols found; inspect files before editing.',
		);
	}
	if (relatedTests.length === 0) {
		riskNotes.push('No related tests found in the structural index.');
	}

	return {
		...createTaskPlan(task, targetFiles),
		inspection: {
			relatedTests,
			riskNotes,
			suggestedVerificationCommands,
			targetFiles,
			targetSymbols,
		},
	};
}

export function renderInspectionTaskPlan(plan) {
	if (!plan?.inspection) {
		return '';
	}
	const inspection = plan.inspection;
	return [
		'## Inspection-derived plan',
		'Target files:',
		renderList(inspection.targetFiles),
		'Target symbols:',
		renderList(
			inspection.targetSymbols.map(
				(symbol) =>
					`${symbol.path}:${symbol.lineStart}-${symbol.lineEnd} ${symbol.kind} ${symbol.name}`,
			),
		),
		'Related tests:',
		renderList(
			inspection.relatedTests.map(
				(test) =>
					`${test.path}:${test.lineStart}-${test.lineEnd} ${test.kind} ${test.name}`,
			),
		),
		'Suggested verification:',
		renderList(inspection.suggestedVerificationCommands),
		'Risk notes:',
		renderList(inspection.riskNotes),
	].join('\n');
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

	if (result.runError) {
		next = updateTask(next, 'verify', 'failed', result.runError.message);
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

function renderList(items) {
	return items.length > 0
		? items.map((item) => `- ${item}`).join('\n')
		: '- (none)';
}

function selectTargetSymbols(task, index, maxSymbols) {
	const terms = queryTokens(task);
	return (index.symbols || [])
		.filter(
			(symbol) =>
				symbol.kind !== 'test' &&
				!/(^|[/.-])(test|tests|spec)([/.-]|$)/iu.test(symbol.path),
		)
		.map((symbol) => ({
			...symbol,
			score: symbolScore(symbol, terms),
		}))
		.filter((symbol) => symbol.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.path.localeCompare(right.path) ||
				left.lineStart - right.lineStart ||
				left.name.localeCompare(right.name),
		)
		.slice(0, maxSymbols)
		.map(({ score, ...symbol }) => ({
			kind: symbol.kind,
			lineEnd: symbol.lineEnd,
			lineStart: symbol.lineStart,
			name: symbol.name,
			path: symbol.path,
		}));
}

function selectTargetFiles(targetSymbols, index, maxFiles) {
	const files = [];
	const seen = new Set();
	for (const symbol of targetSymbols) {
		if (!seen.has(symbol.path)) {
			seen.add(symbol.path);
			files.push(symbol.path);
		}
	}
	for (const symbol of index.rankedSymbols || []) {
		if (files.length >= maxFiles) {
			break;
		}
		if (!seen.has(symbol.path)) {
			seen.add(symbol.path);
			files.push(symbol.path);
		}
	}
	return files.slice(0, maxFiles);
}

function selectRelatedTests(index, targetFiles) {
	const targetBases = new Set(targetFiles.map(baseName));
	return (index.symbols || [])
		.filter(
			(symbol) =>
				symbol.kind === 'test' ||
				/(^|[/.-])(test|tests|spec)([/.-]|$)/iu.test(symbol.path),
		)
		.filter(
			(symbol) =>
				targetBases.size === 0 ||
				targetBases.has(baseName(symbol.path)) ||
				[...targetBases].some((base) => symbol.path.includes(base)),
		)
		.slice(0, 20)
		.map((symbol) => ({
			kind: symbol.kind,
			lineEnd: symbol.lineEnd,
			lineStart: symbol.lineStart,
			name: symbol.name,
			path: symbol.path,
		}));
}

function suggestVerificationCommands(targetFiles, relatedTests) {
	const candidates = [];
	for (const item of [
		...relatedTests,
		...targetFiles.map((path) => ({ path })),
	]) {
		if (isJavaScriptFile(item.path)) {
			if (isTestFile(item.path)) {
				candidates.push(`node --test ${item.path}`);
			} else {
				candidates.push(`node --check ${item.path}`);
			}
		}
	}
	if (relatedTests.some((test) => isJavaScriptFile(test.path))) {
		candidates.push('node --test');
	}
	return [...new Set(candidates)].filter(isAllowlistedVerification);
}

function isAllowlistedVerification(command) {
	try {
		parseVerificationCommand(command);
		return true;
	} catch {
		return false;
	}
}

function symbolScore(symbol, terms) {
	const haystack = `${symbol.name} ${symbol.path} ${symbol.kind}`.toLowerCase();
	return terms.reduce(
		(score, term) => (haystack.includes(term) ? score + term.length : score),
		0,
	);
}

function queryTokens(value) {
	return [
		...new Set(
			String(value)
				.toLowerCase()
				.match(/[a-z0-9_]+/gu) || [],
		),
	]
		.filter((token) => token.length > 1)
		.slice(0, 20);
}

function isJavaScriptFile(path) {
	return /\.(cjs|js|mjs)$/iu.test(path);
}

function isTestFile(path) {
	return /(^|[/.-])(test|tests|spec)([/.-]|$)/iu.test(path);
}

function baseName(path) {
	return path
		.split('/')
		.at(-1)
		.replace(/\.(test|spec)\.[^.]+$/iu, '')
		.replace(/\.[^.]+$/u, '');
}

function slugPath(path) {
	return path
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/gu, '-')
		.replaceAll(/^-|-$/gu, '')
		.slice(0, 80);
}
