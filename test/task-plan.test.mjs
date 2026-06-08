import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createInspectionTaskPlan,
	createTaskPlan,
	renderInspectionTaskPlan,
	taskCounts,
	TaskPlanError,
	updateTask,
	updateTasksFromRun,
} from '../src/task-plan.mjs';

describe('task planning', () => {
	it('creates stable tasks from requested paths', () => {
		const plan = createTaskPlan('build todo app', [
			'examples/todo-cli/src/cli.mjs',
		]);

		assert.deepEqual(
			plan.tasks.map((task) => task.id),
			[
				'understand-request',
				'inspect-context',
				'edit-examples-todo-cli-src-cli-mjs',
				'verify',
				'document',
			],
		);
		assert.equal(plan.tasks[2].path, 'examples/todo-cli/src/cli.mjs');
		assert.deepEqual(taskCounts(plan), {
			completed: 2,
			failed: 0,
			in_progress: 0,
			pending: 3,
		});
	});

	it('updates tasks immutably and rejects invalid transitions', () => {
		const plan = createTaskPlan('change docs');
		const updated = updateTask(plan, 'verify', 'completed', 'Tests passed.');

		assert.equal(
			plan.tasks.find((task) => task.id === 'verify').status,
			'pending',
		);
		assert.equal(
			updated.tasks.find((task) => task.id === 'verify').status,
			'completed',
		);
		assert.throws(
			() => updateTask(plan, 'missing', 'completed'),
			TaskPlanError,
		);
		assert.throws(() => updateTask(plan, 'verify', 'unknown'), TaskPlanError);
	});

	it('updates proposal and verification task state from a run result', () => {
		const plan = createTaskPlan('build todo app', [
			'examples/todo-cli/src/cli.mjs',
		]);
		const updated = updateTasksFromRun(plan, {
			ok: false,
			proposalFound: true,
			tested: true,
		});

		assert.equal(
			updated.tasks.find(
				(task) => task.path === 'examples/todo-cli/src/cli.mjs',
			).status,
			'completed',
		);
		assert.equal(
			updated.tasks.find((task) => task.id === 'verify').status,
			'failed',
		);
		assert.equal(
			updated.tasks.find((task) => task.id === 'document').status,
			'completed',
		);
	});

	it('marks verification failed for run-level errors without failing edits', () => {
		const plan = createTaskPlan('build API', ['src/server.js']);
		const updated = updateTasksFromRun(plan, {
			ok: false,
			proposalFound: true,
			runError: {
				message: 'Verification did not run.',
				name: 'StagedUnverifiedError',
			},
			tested: false,
		});

		assert.equal(
			updated.tasks.find((task) => task.path === 'src/server.js').status,
			'completed',
		);
		assert.equal(
			updated.tasks.find((task) => task.id === 'verify').status,
			'failed',
		);
	});

	it('creates an inspection-derived task plan with symbols tests and allowlisted verification', () => {
		const plan = createInspectionTaskPlan('change runPrompt', {
			rankedSymbols: [],
			symbols: [
				{
					kind: 'function',
					lineEnd: 20,
					lineStart: 10,
					name: 'runPrompt',
					path: 'src/app.mjs',
				},
				{
					kind: 'test',
					lineEnd: 8,
					lineStart: 1,
					name: 'runPrompt works',
					path: 'test/app.test.mjs',
				},
			],
		});

		assert.deepEqual(plan.inspection.targetFiles, ['src/app.mjs']);
		assert.equal(plan.inspection.targetSymbols[0].name, 'runPrompt');
		assert.equal(plan.inspection.relatedTests[0].path, 'test/app.test.mjs');
		assert.deepEqual(plan.inspection.suggestedVerificationCommands, [
			'node --test test/app.test.mjs',
			'node --check src/app.mjs',
			'node --test',
		]);
		assert.equal(
			plan.tasks.some((task) => task.path === 'src/app.mjs'),
			true,
		);
		assert.match(renderInspectionTaskPlan(plan), /Inspection-derived plan/u);
	});
});
