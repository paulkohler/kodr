import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	LMSTUDIO_BASE_URL,
	ModelSpecError,
	OPENROUTER_BASE_URL,
	parseAgentModelOverride,
	parseSlashModelSpec,
	resolveAgentModels,
	resolveModelOptions,
} from '../src/model-specs.mjs';

describe('model specs', () => {
	it('parses provider/model specs using only the first slash', () => {
		assert.deepEqual(
			parseSlashModelSpec('lmstudio/nvidia/nemotron-3-nano-omni'),
			{
				model: 'nvidia/nemotron-3-nano-omni',
				provider: 'lmstudio',
				spec: 'lmstudio/nvidia/nemotron-3-nano-omni',
			},
		);
		assert.deepEqual(parseSlashModelSpec('qwen/qwen3.6-35b-a3b', 'local'), {
			model: 'qwen/qwen3.6-35b-a3b',
			provider: 'local',
			spec: 'qwen/qwen3.6-35b-a3b',
		});
	});

	it('resolves OpenRouter and local provider options', () => {
		const base = {
			apiKey: '',
			baseUrl: 'http://custom-local/v1',
			extraHeaders: {},
			model: 'base-model',
			provider: 'local',
		};
		const openrouter = resolveModelOptions(
			base,
			{ OPENROUTER_API_KEY: 'or-key' },
			'openrouter/anthropic/claude-opus',
		);
		assert.equal(openrouter.provider, 'openrouter');
		assert.equal(openrouter.model, 'anthropic/claude-opus');
		assert.equal(openrouter.baseUrl, OPENROUTER_BASE_URL);
		assert.equal(openrouter.apiKey, 'or-key');

		const local = resolveModelOptions(
			{ ...openrouter, provider: 'openrouter' },
			{},
			'lmstudio/qwen/qwen3.6-35b-a3b',
		);
		assert.equal(local.provider, 'lmstudio');
		assert.equal(local.model, 'qwen/qwen3.6-35b-a3b');
		assert.equal(local.baseUrl, LMSTUDIO_BASE_URL);
	});

	it('reuses custom local base URLs for lmstudio overrides', () => {
		const base = {
			apiKey: '',
			baseUrl: 'http://custom-lmstudio/v1',
			extraHeaders: {},
			model: 'base-model',
			provider: 'local',
		};

		const resolved = resolveAgentModels(
			{
				...base,
				agentModelSpecs: {
					planner: 'lmstudio/qwen/qwen3.6-35b-a3b',
				},
			},
			{},
		);

		assert.equal(resolved.planner.baseUrl, 'http://custom-lmstudio/v1');
		assert.equal(resolved.planner.model, 'qwen/qwen3.6-35b-a3b');
	});

	it('parses and resolves agent model overrides', () => {
		assert.deepEqual(parseAgentModelOverride('planner=openrouter/a/b'), {
			agent: 'planner',
			spec: 'openrouter/a/b',
		});
		assert.throws(
			() => parseAgentModelOverride('healer=openrouter/a/b'),
			ModelSpecError,
		);

		const agentModels = resolveAgentModels(
			{
				agentModelSpecs: {
					planner: 'openrouter/a/b',
					reviewer: 'lmstudio/c/d',
				},
				apiKey: '',
				baseUrl: 'http://localhost:1234/v1',
				extraHeaders: {},
				model: 'base',
				provider: 'local',
			},
			{ OPENROUTER_API_KEY: 'or-key' },
		);
		assert.equal(agentModels.planner.provider, 'openrouter');
		assert.equal(agentModels.planner.model, 'a/b');
		assert.equal(agentModels.reviewer.provider, 'lmstudio');
		assert.equal(agentModels.reviewer.model, 'c/d');
	});
});
