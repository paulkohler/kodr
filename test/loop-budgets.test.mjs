import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLoopBudget, LoopBudgetError } from '../src/loop-budgets.mjs';

describe('loop budgets', () => {
	it('tracks turns, retries, tokens, and stop reasons', () => {
		const budget = createLoopBudget({
			maxRetries: 1,
			maxTokens: 10,
			maxTurns: 2,
		});

		budget.beforeTurn();
		budget.recordUsage({ total_tokens: 4 });
		budget.recordRetry();
		budget.beforeTurn();
		budget.recordUsage({ prompt_tokens: 2, completion_tokens: 3 });
		budget.stop('finish_stop');

		assert.deepEqual(budget.snapshot(), {
			completionTokens: 3,
			cost: 0,
			costUsd: 0,
			maxCostUsd: null,
			maxRetries: 1,
			maxTokens: 10,
			maxTurns: 2,
			promptTokens: 2,
			retries: 1,
			stopReason: 'finish_stop',
			tokens: 9,
			turns: 2,
		});
	});

	it('throws with state when a budget is exhausted', () => {
		const budget = createLoopBudget({ maxTurns: 1 });

		budget.beforeTurn();

		assert.throws(() => budget.beforeTurn(), LoopBudgetError);
		assert.equal(budget.snapshot().stopReason, 'turn_budget_exhausted');
	});

	it('enforces reported cost usage', () => {
		const budget = createLoopBudget({ maxCostUsd: 0.01 });

		budget.beforeTurn();

		assert.throws(
			() => budget.recordUsage({ costUsd: 0.02 }),
			/cost_budget_exhausted/u,
		);
		assert.equal(budget.snapshot().cost, 0.02);
		assert.equal(budget.snapshot().costUsd, 0.02);
	});

	it('accepts provider-neutral cost usage', () => {
		const budget = createLoopBudget({ maxCostUsd: 0.05 });

		budget.beforeTurn();
		budget.recordUsage({ cost: 0.02 });

		assert.equal(budget.snapshot().cost, 0.02);
		assert.equal(budget.snapshot().costUsd, 0.02);
	});
});
