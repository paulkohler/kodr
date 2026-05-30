import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeModelUsage } from '../src/usage-normalizer.mjs';

describe('normalizeModelUsage', () => {
	it('maps local provider cost to zero', () => {
		assert.deepEqual(
			normalizeModelUsage('local', {
				cost: 1,
				prompt_tokens: 10,
				total_tokens: 12,
			}),
			{
				cost: 0,
				costUsd: 0,
				prompt_tokens: 10,
				total_tokens: 12,
			},
		);
	});

	it('maps OpenRouter usage.cost to internal cost fields', () => {
		assert.deepEqual(
			normalizeModelUsage('openrouter', {
				completion_tokens: 4,
				cost: 0.0025,
				prompt_tokens: 8,
				total_tokens: 12,
			}),
			{
				completion_tokens: 4,
				cost: 0.0025,
				costUsd: 0.0025,
				prompt_tokens: 8,
				total_tokens: 12,
			},
		);
	});

	it('rejects cost budgets for unmapped providers', () => {
		assert.throws(
			() =>
				normalizeModelUsage(
					'future-provider',
					{ total_tokens: 1 },
					{ maxCostUsd: '0.01' },
				),
			/--max-cost-usd is not supported/u,
		);
	});
});
