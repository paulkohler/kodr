import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createWorkflowPlan,
	reviewWorkflowProposal,
	runWorkflow,
	WORKFLOW_STAGES,
} from '../src/workflow.mjs';

describe('workflow mode', () => {
	it('creates all workflow stages', () => {
		const plan = createWorkflowPlan('change docs', [{ path: 'README.md' }]);

		assert.deepEqual(
			plan.stages.map((stage) => stage.name),
			WORKFLOW_STAGES,
		);
		assert.deepEqual(plan.proposedPaths, ['README.md']);
	});

	it('approves proposals that only touch reviewed paths', () => {
		const result = runWorkflow('change docs', {
			files: [
				{
					content: 'new',
					path: 'README.md',
				},
			],
		});

		assert.equal(result.review.ok, true);
		assert.equal(result.report.ok, true);
	});

	it('rejects proposals that touch paths outside the reviewed plan', () => {
		const plan = createWorkflowPlan('change docs', [{ path: 'README.md' }]);
		const review = reviewWorkflowProposal(plan, {
			files: [
				{
					content: 'new',
					path: 'src/app.mjs',
				},
			],
		});

		assert.equal(review.ok, false);
		assert.deepEqual(review.unplanned, ['src/app.mjs']);
	});
});
