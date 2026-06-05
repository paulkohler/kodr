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
				promptTokens: 10,
				prompt_tokens: 10,
				tokens: 12,
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
				completionTokens: 4,
				cost: 0.0025,
				costUsd: 0.0025,
				promptTokens: 8,
				prompt_tokens: 8,
				tokens: 12,
				total_tokens: 12,
			},
		);
	});

	it('maps cache counters from OpenRouter-style usage details', () => {
		assert.deepEqual(
			normalizeModelUsage('openrouter', {
				completion_tokens: 4,
				cost: 0.003,
				prompt_tokens: 20,
				prompt_tokens_details: {
					cache_write_tokens: 7,
					cached_tokens: 12,
				},
				total_tokens: 24,
			}),
			{
				cacheReadTokens: 12,
				cacheWriteTokens: 7,
				cachedTokens: 12,
				completionTokens: 4,
				completion_tokens: 4,
				cost: 0.003,
				costUsd: 0.003,
				promptTokens: 20,
				prompt_tokens: 20,
				prompt_tokens_details: {
					cache_write_tokens: 7,
					cached_tokens: 12,
				},
				tokens: 24,
				total_tokens: 24,
			},
		);
	});

	it('maps Anthropic-style input/output and cache read/write usage', () => {
		assert.deepEqual(
			normalizeModelUsage('openrouter', {
				cache_creation_input_tokens: 30,
				cache_read_input_tokens: 90,
				cost: 0.004,
				input_tokens: 100,
				output_tokens: 5,
			}),
			{
				cache_creation_input_tokens: 30,
				cache_read_input_tokens: 90,
				cacheReadTokens: 90,
				cacheWriteTokens: 30,
				completionTokens: 5,
				completion_tokens: 5,
				cost: 0.004,
				costUsd: 0.004,
				input_tokens: 100,
				output_tokens: 5,
				promptTokens: 100,
				prompt_tokens: 100,
				tokens: 105,
				total_tokens: 105,
			},
		);
	});

	it('does not zero Ollama cloud model costs', () => {
		assert.deepEqual(
			normalizeModelUsage(
				'ollama',
				{ cost: 0.01, prompt_tokens: 8, total_tokens: 9 },
				{ model: 'minimax-m3:cloud' },
			),
			{
				cost: 0.01,
				costUsd: 0.01,
				promptTokens: 8,
				prompt_tokens: 8,
				tokens: 9,
				total_tokens: 9,
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
