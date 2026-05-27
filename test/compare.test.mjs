import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildModelOptions,
	parseModelSpec,
	runComparison,
} from '../src/compare.mjs';
import { CliError, main, parseArgs } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('parseModelSpec', () => {
	it('parses a plain local model spec', () => {
		const spec = parseModelSpec('qwen/qwen3.6-35b-a3b');
		assert.equal(spec.provider, 'local');
		assert.equal(spec.modelId, 'qwen/qwen3.6-35b-a3b');
	});

	it('parses an openrouter: prefix spec', () => {
		const spec = parseModelSpec('openrouter:openai/gpt-5.4-nano');
		assert.equal(spec.provider, 'openrouter');
		assert.equal(spec.modelId, 'openai/gpt-5.4-nano');
	});

	it('treats anything without the prefix as local', () => {
		const spec = parseModelSpec('meta-llama/Llama-3-8b-instruct');
		assert.equal(spec.provider, 'local');
	});
});

describe('buildModelOptions', () => {
	it('local spec preserves base URL and clears extra headers', () => {
		const base = {
			baseUrl: 'http://localhost:1234/v1',
			extraHeaders: {},
			apiKey: '',
		};
		const opts = buildModelOptions(
			base,
			{ provider: 'local', modelId: 'some/model' },
			{},
		);
		assert.equal(opts.baseUrl, 'http://localhost:1234/v1');
		assert.equal(opts.model, 'some/model');
	});

	it('openrouter spec overrides URL, key, and headers', () => {
		const base = {
			baseUrl: 'http://localhost:1234/v1',
			extraHeaders: {},
			apiKey: '',
		};
		const opts = buildModelOptions(
			base,
			{ provider: 'openrouter', modelId: 'openai/gpt-4o-mini' },
			{ OPENROUTER_API_KEY: 'or-key' },
		);
		assert.equal(opts.baseUrl, 'https://openrouter.ai/api/v1');
		assert.equal(opts.apiKey, 'or-key');
		assert.equal(opts.model, 'openai/gpt-4o-mini');
		assert.ok(opts.extraHeaders['HTTP-Referer']);
		assert.equal(opts.extraHeaders['X-Title'], 'kodr');
	});

	it('openrouter falls back to OPENAI_API_KEY when OPENROUTER_API_KEY absent', () => {
		const base = { baseUrl: '', extraHeaders: {}, apiKey: '' };
		const opts = buildModelOptions(
			base,
			{ provider: 'openrouter', modelId: 'x' },
			{ OPENAI_API_KEY: 'oai-key' },
		);
		assert.equal(opts.apiKey, 'oai-key');
	});
});

describe('runComparison', () => {
	it('runs two models in sequence and writes comparison.json', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-compare-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Hello from model A.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_a',
						object: 'chat.completion',
					},
					status: 200,
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Hello from model B.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_b',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			const baseOptions = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				apiKey: '',
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const { compDir, comparison } = await runComparison(
				baseOptions,
				{},
				'Say hello.',
				'You are helpful.',
				['model-a', 'model-b'],
				cwd,
				'',
			);

			assert.equal(comparison.models.length, 2);
			assert.equal(comparison.models[0].modelId, 'model-a');
			assert.equal(comparison.models[0].ok, true);
			assert.equal(comparison.models[0].provider, 'local');
			assert.ok(comparison.models[0].responseChars > 0);
			assert.equal(comparison.models[1].modelId, 'model-b');
			assert.equal(comparison.models[1].ok, true);
			assert.equal(comparison.prompt, 'Say hello.');
			assert.ok(comparison.timestamp);

			// Artifact layout: comparison.json at root, per-model subdirs
			const compJson = JSON.parse(
				await readFile(join(compDir, 'comparison.json'), 'utf8'),
			);
			assert.equal(compJson.models.length, 2);

			const responseA = await readFile(
				join(compDir, 'model-a', 'response.md'),
				'utf8',
			);
			assert.ok(responseA.includes('model A'));
		} finally {
			await server.close();
		}
	});

	it('records error for a failing model without aborting the comparison', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-compare-fail-'));
		const server = await startFakeModelServer({
			responses: [
				// First model returns HTTP 500
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: { error: 'server exploded' },
					status: 500,
				},
				// Second model succeeds
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Model B ok.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_b',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			const baseOptions = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				apiKey: '',
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const { comparison } = await runComparison(
				baseOptions,
				{},
				'Say hello.',
				'You are helpful.',
				['fail-model', 'ok-model'],
				cwd,
				'',
			);

			assert.equal(comparison.models[0].ok, false);
			assert.ok(comparison.models[0].error);
			assert.ok(comparison.models[0].error.message.includes('500'));
			assert.equal(comparison.models[1].ok, true);
		} finally {
			await server.close();
		}
	});

	it('saves per-model result.json and raw-response.json artifacts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-compare-artifacts-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Done.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			const baseOptions = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				apiKey: '',
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const { compDir } = await runComparison(
				baseOptions,
				{},
				'Hi.',
				'',
				['solo-model'],
				cwd,
				'',
			);

			const resultJson = JSON.parse(
				await readFile(join(compDir, 'solo-model', 'result.json'), 'utf8'),
			);
			assert.equal(resultJson.modelId, 'solo-model');
			assert.equal(resultJson.ok, true);
			assert.ok(typeof resultJson.durationMs === 'number');

			const rawJson = JSON.parse(
				await readFile(
					join(compDir, 'solo-model', 'raw-response.json'),
					'utf8',
				),
			);
			assert.ok(Array.isArray(rawJson.responses));
		} finally {
			await server.close();
		}
	});
});

describe('parseArgs compare command', () => {
	it('parses --models flag into an array', () => {
		const options = parseArgs([
			'compare',
			'-p',
			'hi',
			'--models',
			'model-a,model-b',
		]);
		assert.equal(options.command, 'compare');
		assert.deepEqual(options.models, ['model-a', 'model-b']);
	});

	it('trims whitespace from model specs', () => {
		const options = parseArgs([
			'compare',
			'-p',
			'hi',
			'--models',
			'model-a , model-b',
		]);
		assert.deepEqual(options.models, ['model-a', 'model-b']);
	});

	it('throws when --models is missing its value', () => {
		assert.throws(() => parseArgs(['compare', '--models']), CliError);
	});
});

describe('main compare command', () => {
	it('runs comparison and returns ok result', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-compare-main-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Hi.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			let output = '';
			const io = {
				cwd,
				env: { BASE_URL: server.baseUrl },
				stdout: { write: (s) => (output += s) },
			};

			const result = await main(
				['compare', '-p', 'Say hi.', '--models', 'test-model'],
				io,
			);

			assert.equal(result.ok, true);
			assert.equal(result.command, 'compare');
			assert.ok(output.includes('Compare ok'));
			assert.ok(output.includes('test-model'));
		} finally {
			await server.close();
		}
	});

	it('throws CliError when --models is absent', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-compare-nomodels-'));
		const io = {
			cwd,
			env: {},
			stdout: { write: () => {} },
		};
		await assert.rejects(() => main(['compare', '-p', 'hi'], io), CliError);
	});
});
