import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CliError, main, parseArgs, usage, VERSION } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('parseArgs', () => {
	it('starts with LM Studio-friendly defaults', () => {
		const options = parseArgs([], {});

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.model, 'qwen/qwen3.6-35b-a3b');
		assert.equal(options.timeoutMs, 600000);
		assert.equal(options.maxTurns, 8);
		assert.equal(options.maxRetries, 7);
	});

	it('parses model endpoint flags', () => {
		const options = parseArgs([
			'--base-url',
			'http://localhost:1234/v1/',
			'--model',
			'nvidia/nemotron-3-nano-omni',
			'--out',
			'custom-run',
			'--prompt-file',
			'prompt.md',
			'--test-cwd',
			'examples/todo-cli',
			'--api-key',
			'test-key',
			'--timeout-ms',
			'1000',
			'--max-turns',
			'3',
			'--max-retries',
			'2',
			'--max-tokens',
			'100',
			'--max-cost-usd',
			'0.01',
			'--json',
		]);

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.model, 'nvidia/nemotron-3-nano-omni');
		assert.equal(options.out, 'custom-run');
		assert.equal(options.promptFile, 'prompt.md');
		assert.equal(options.testCwd, 'examples/todo-cli');
		assert.equal(options.apiKey, 'test-key');
		assert.equal(options.timeoutMs, 1000);
		assert.equal(options.maxTurns, 3);
		assert.equal(options.maxRetries, 2);
		assert.equal(options.maxTokens, 100);
		assert.equal(options.maxCostUsd, '0.01');
		assert.equal(options.json, true);
	});

	it('parses cycle review flags', () => {
		const options = parseArgs([
			'cycle-review',
			'--transcript-file',
			'chat.md',
			'--out',
			'cycle-run',
		]);

		assert.equal(options.command, 'cycle-review');
		assert.equal(options.transcriptFile, 'chat.md');
		assert.equal(options.out, 'cycle-run');
	});

	it('rejects unknown options', () => {
		assert.throws(() => parseArgs(['--wat']), CliError);
	});

	it('accepts flag values that start with -- or are empty', () => {
		const dashed = parseArgs(['run', '-p', '--not-a-flag']);
		assert.equal(dashed.prompt, '--not-a-flag');

		const empty = parseArgs(['run', '-p', '']);
		assert.equal(empty.prompt, '');
	});

	it('throws when a value-bearing flag has no following token', () => {
		assert.throws(() => parseArgs(['run', '-p']), CliError);
		assert.throws(() => parseArgs(['compare', '--models']), CliError);
	});

	it('--openrouter applies OpenRouter defaults', () => {
		const options = parseArgs(['--openrouter'], {
			OPENROUTER_API_KEY: 'or-test-key',
		});

		assert.equal(options.provider, 'openrouter');
		assert.equal(options.baseUrl, 'https://openrouter.ai/api/v1');
		assert.equal(options.model, 'openai/gpt-4o-mini');
		assert.equal(options.apiKey, 'or-test-key');
		assert.equal(options.extraHeaders['HTTP-Referer'] !== undefined, true);
		assert.equal(options.extraHeaders['X-Title'], 'kodr');
	});

	it('--openrouter falls back to OPENAI_API_KEY when OPENROUTER_API_KEY absent', () => {
		const options = parseArgs(['--openrouter'], {
			OPENAI_API_KEY: 'oai-fallback',
		});

		assert.equal(options.apiKey, 'oai-fallback');
	});

	it('--openrouter throws when no API key is available', () => {
		assert.throws(() => parseArgs(['--openrouter'], {}), CliError);
	});

	it('explicit flags override --openrouter defaults', () => {
		const options = parseArgs(
			[
				'--openrouter',
				'--base-url',
				'https://custom.endpoint/v1',
				'--model',
				'anthropic/claude-3-haiku',
				'--api-key',
				'explicit-key',
			],
			{ OPENROUTER_API_KEY: 'should-be-ignored' },
		);

		assert.equal(options.baseUrl, 'https://custom.endpoint/v1');
		assert.equal(options.model, 'anthropic/claude-3-haiku');
		assert.equal(options.apiKey, 'explicit-key');
	});

	it('--openrouter does not expose _apiKeySet on returned options', () => {
		const options = parseArgs(['--openrouter'], {
			OPENROUTER_API_KEY: 'or-key',
		});

		assert.equal('_apiKeySet' in options, false);
	});
});

describe('usage', () => {
	it('mentions the current version and planned commands', () => {
		const text = usage();

		assert.match(text, new RegExp(VERSION));
		assert.match(text, /kodr probe/u);
	});
});

describe('probe', () => {
	it('calls OpenAI-compatible endpoints and writes run artifacts', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-'));
			const stdout = captureStream();
			const result = await main(
				[
					'probe',
					'--base-url',
					server.baseUrl,
					'--api-key',
					'secret-test-key',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.command, 'probe');
			assert.equal(result.result.model, 'qwen/qwen3.6-35b-a3b');
			assert.equal(result.result.reply, 'kodr-probe-ok');

			const output = JSON.parse(stdout.text);
			assert.equal(output.ok, true);
			assert.equal(output.model, 'qwen/qwen3.6-35b-a3b');

			assert.deepEqual(
				server.recordings.map((recording) => {
					return `${recording.method} ${recording.url}`;
				}),
				['GET /v1/models', 'POST /v1/chat/completions'],
			);
			assert.equal(
				server.recordings[0].requestHeaders.authorization,
				'[redacted]',
			);
			assert.equal(
				server.recordings[1].requestHeaders.authorization,
				'[redacted]',
			);

			const chatRequest = server.recordings[1].requestBody;
			assert.equal(chatRequest.model, 'qwen/qwen3.6-35b-a3b');
			assert.equal(chatRequest.messages[0].role, 'user');
			assert.equal(
				server.recordings[1].responseBody.choices[0].message.content,
				'kodr-probe-ok',
			);

			const artifact = JSON.parse(
				await readFile(join(output.runDir, 'result.json'), 'utf8'),
			);
			assert.equal(artifact.ok, true);
			assert.equal(artifact.reply, 'kodr-probe-ok');

			const chatResponse = JSON.parse(
				await readFile(join(output.runDir, 'chat-response.json'), 'utf8'),
			);
			assert.equal(chatResponse.status, 200);
		} finally {
			await server.close();
		}
	});

	it('fails when the model server returns invalid JSON', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: 'not json',
					method: 'GET',
					url: '/v1/models',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-bad-json-'));

			await assert.rejects(
				() =>
					main(
						['probe', '--base-url', server.baseUrl, '--timeout-ms', '1000'],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/invalid JSON/u,
			);
		} finally {
			await server.close();
		}
	});
});

describe('run', () => {
	it('runs a prompt and writes inspectable artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'A compact answer.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_run',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Summarize the repo.',
					'--base-url',
					server.baseUrl,
					'--out',
					'run-output',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.command, 'run');
			assert.equal(result.result.response, 'A compact answer.');

			const output = JSON.parse(stdout.text);
			assert.equal(output.responseChars, 'A compact answer.'.length);
			assert.deepEqual(output.finishReasons, ['stop']);

			assert.equal(
				await readFile(join(cwd, 'run-output', 'prompt.md'), 'utf8'),
				'Summarize the repo.',
			);
			assert.equal(
				await readFile(join(cwd, 'run-output', 'response.md'), 'utf8'),
				'A compact answer.',
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'run-output', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.model, 'qwen/qwen3.6-35b-a3b');
			assert.equal(summary.responseCount, 1);
			assert.equal(summary.promptChars, 'Summarize the repo.'.length);
			assert.deepEqual(summary.artifacts, {
				context: 'context.md',
				messages: 'messages.json',
				prompt: 'prompt.md',
				rawRequest: 'raw-request.json',
				rawResponse: 'raw-response.json',
				response: 'response.md',
				scratchpad: 'scratchpad.md',
				summary: 'summary.json',
				tasks: 'tasks.json',
				tests: 'tests.json',
				writes: 'writes.json',
			});
			assert.equal(Object.hasOwn(summary, 'runDir'), false);

			const raw = JSON.parse(
				await readFile(join(cwd, 'run-output', 'raw-response.json'), 'utf8'),
			);
			assert.equal(raw.responses[0].id, 'chatcmpl_run');

			const chatRequest = server.recordings[0].requestBody;
			assert.equal(chatRequest.messages[0].role, 'system');
			assert.match(chatRequest.messages[0].content, /You are Kodr/u);
			assert.equal(chatRequest.messages[1].content, 'Summarize the repo.');
			assert.equal(chatRequest.model, 'qwen/qwen3.6-35b-a3b');
		} finally {
			await server.close();
		}
	});

	it('prints a human-readable summary in non-JSON mode', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: proposalResponse({
						files: [
							{ path: 'src/index.mjs', content: 'export const x = 1;\n' },
						],
						messages: [{ level: 'info', content: 'Added a constant.' }],
						scratchpad: 'Plan: add a module.',
					}),
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-summary-'));
			const stdout = captureStream();
			await main(
				[
					'run',
					'-p',
					'Add a module.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			// The summary names the proposed file, its create status, the dry-run
			// mode, the model message, and how to apply — not just "Run ok".
			assert.match(stdout.text, /^Run ok/u);
			assert.match(stdout.text, /1 file\(s\), dry-run/u);
			assert.match(stdout.text, /create\s+src\/index\.mjs/u);
			assert.match(stdout.text, /\[info\] Added a constant\./u);
			assert.match(stdout.text, /Re-run with --yes/u);
		} finally {
			await server.close();
		}
	});

	it('prints the response text when the model returns no proposal', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: proposalResponseText(
						'Just a plain prose answer, no JSON here.',
					),
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-prose-'));
			const stdout = captureStream();
			await main(
				[
					'run',
					'-p',
					'Explain something.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			assert.match(stdout.text, /Response:/u);
			assert.match(stdout.text, /Just a plain prose answer/u);
		} finally {
			await server.close();
		}
	});

	it('runs without querying /models when a model is provided', async () => {
		const server = await startFakeModelServer({
			responses: [
				// A 404 for /models proves the run never depends on discovery.
				{
					method: 'GET',
					url: '/v1/models',
					status: 404,
					body: { error: 'not found' },
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_no_models',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-no-models-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--model',
					'explicit-model',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.equal(result.ok, true);
			assert.equal(result.result.model, 'explicit-model');
			// Only the chat completion is recorded; /models was never called.
			assert.equal(server.recordings.length, 1);
			assert.equal(server.recordings[0].url, '/v1/chat/completions');
		} finally {
			await server.close();
		}
	});

	it('reads prompts from --prompt-file and stitches length continuations', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'length',
								message: {
									content: 'First half ',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_part_1',
						object: 'chat.completion',
						usage: {
							completion_tokens: 2,
							prompt_tokens: 3,
							total_tokens: 5,
						},
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'second half.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_part_2',
						object: 'chat.completion',
						usage: {
							completion_tokens: 2,
							prompt_tokens: 4,
							total_tokens: 6,
						},
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-file-'));
			await writeFile(join(cwd, 'prompt.md'), 'Continue this thought.', 'utf8');

			const result = await main(
				[
					'run',
					'--prompt-file',
					'prompt.md',
					'--base-url',
					server.baseUrl,
					'--out',
					'stitched-output',
					'--timeout-ms',
					'1000',
					'--max-turns',
					'2',
					'--max-tokens',
					'20',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.response, 'First half second half.');
			assert.deepEqual(result.result.finishReasons, ['length', 'stop']);
			assert.deepEqual(result.result.loopBudget, {
				completionTokens: 4,
				costUsd: 0,
				maxCostUsd: null,
				maxRetries: 7,
				maxTokens: 20,
				maxTurns: 2,
				promptTokens: 7,
				retries: 1,
				stopReason: 'finish_stop',
				tokens: 11,
				turns: 2,
			});
			assert.equal(
				await readFile(join(cwd, 'stitched-output', 'response.md'), 'utf8'),
				'First half second half.',
			);

			const raw = JSON.parse(
				await readFile(
					join(cwd, 'stitched-output', 'raw-response.json'),
					'utf8',
				),
			);
			assert.deepEqual(
				raw.responses.map((response) => response.id),
				['chatcmpl_part_1', 'chatcmpl_part_2'],
			);
			assert.equal(raw.loopBudget.tokens, 11);

			const continuationRequest = server.recordings[1].requestBody;
			assert.equal(continuationRequest.messages[2].role, 'assistant');
			assert.equal(continuationRequest.messages[2].content, 'First half ');
			assert.equal(
				continuationRequest.messages[3].content,
				'Continue from exactly where you stopped.',
			);
		} finally {
			await server.close();
		}
	});

	it('stops continuation runs at the turn budget', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'length',
								message: {
									content: 'unfinished',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_budget_1',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-budget-'));
			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'Keep going forever.',
							'--base-url',
							server.baseUrl,
							'--out',
							'budget-output',
							'--timeout-ms',
							'1000',
							'--max-turns',
							'1',
						],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/turn_budget_exhausted/u,
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'budget-output', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.match(summary.error.message, /turn_budget_exhausted/u);
		} finally {
			await server.close();
		}
	});

	it('can read streaming chat completions', async () => {
		const streamBody = [
			'data: {"id":"stream-1","choices":[{"delta":{"content":"streamed "},"finish_reason":null}]}',
			'',
			'data: {"id":"stream-1","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
			'',
			'data: [DONE]',
			'',
		].join('\n');
		const server = await startFakeModelServer({
			responses: [
				{
					body: streamBody,
					headers: {
						'content-type': 'text/event-stream',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-stream-'));
			const result = await main(
				[
					'run',
					'-p',
					'Stream a response.',
					'--base-url',
					server.baseUrl,
					'--stream',
					'--timeout-ms',
					'1000',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.response, 'streamed answer');
			assert.deepEqual(result.result.finishReasons, ['stop']);
			assert.equal(server.recordings[0].requestBody.stream, true);
		} finally {
			await server.close();
		}
	});

	it('writes failure artifacts when model completion fails', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						error: 'model unavailable',
					},
					method: 'POST',
					status: 500,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-model-fail-'));

			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'Build an example.',
							'--base-url',
							server.baseUrl,
							'--out',
							'failed-run',
							'--timeout-ms',
							'1000',
						],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/Model run failed/u,
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'failed-run', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.equal(summary.artifacts.error, 'error.json');
			assert.match(summary.error.message, /HTTP 500/u);
			assert.equal(
				await readFile(join(cwd, 'failed-run', 'prompt.md'), 'utf8'),
				'Build an example.',
			);
		} finally {
			await server.close();
		}
	});

	it('rejects ambiguous prompt input', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-ambiguous-'));

		await assert.rejects(
			() =>
				main(['run', '-p', 'one', '--prompt-file', 'prompt.md'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/either/u,
		);
	});

	it('rejects prompt-file paths outside the workspace', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'kodr-run-prompt-escape-'));
		const cwd = join(parent, 'workspace');
		await mkdir(cwd, { recursive: true });
		await writeFile(join(parent, 'prompt.md'), 'outside', 'utf8');

		await assert.rejects(
			() =>
				main(['run', '--prompt-file', '../prompt.md'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Parent path segments/u,
		);
	});

	it('prints packed context without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-context-'));
			await writeFile(join(cwd, 'AGENTS.md'), 'Use local models.', 'utf8');
			await writeFile(join(cwd, 'a.txt'), 'alpha', 'utf8');
			const stdout = captureStream();

			const result = await main(
				['run', '--show-context', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.match(stdout.text, /## AGENTS\.md/u);
			assert.match(stdout.text, /Use local models/u);
			assert.match(stdout.text, /## a\.txt/u);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('prints deterministic context file paths without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-files-'));
			await writeFile(join(cwd, 'b.txt'), 'b', 'utf8');
			await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
			const stdout = captureStream();

			const result = await main(
				['run', '--show-files', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.deepEqual(stdout.text.trim().split('\n'), ['a.txt', 'b.txt']);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('prints discovered Markdown skills without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-skills-'));
			await mkdir(join(cwd, 'skills', 'edit'), { recursive: true });
			await writeFile(
				join(cwd, 'skills', 'edit', 'SKILL.md'),
				'---\nname: editor\ndescription: Edit files\n---\nUse patches.',
				'utf8',
			);
			const stdout = captureStream();

			const result = await main(
				['run', '--show-skills', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.match(stdout.text, /editor/u);
			assert.match(stdout.text, /skills\/edit\/SKILL\.md/u);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('loads requested Markdown skills into the system prompt', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-load-skill-'));
			await mkdir(join(cwd, 'skills', 'review'), { recursive: true });
			await writeFile(
				join(cwd, 'skills', 'review', 'SKILL.md'),
				'---\nname: reviewer\ndescription: Review code\n---\nAlways inspect tests.',
				'utf8',
			);

			await main(
				[
					'run',
					'-p',
					'Check the change.',
					'--skill',
					'reviewer',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			const chatRequest = server.recordings[0].requestBody;
			assert.match(
				chatRequest.messages[0].content,
				/Available Markdown skills/u,
			);
			assert.match(chatRequest.messages[0].content, /Loaded Markdown skills/u);
			assert.match(chatRequest.messages[0].content, /Always inspect tests/u);
		} finally {
			await server.close();
		}
	});

	it('dry-runs extracted file proposals by default', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'new readme',
								path: 'README.md',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-dry-'));
			await writeFile(join(cwd, 'README.md'), 'old readme', 'utf8');

			const result = await main(
				['run', '-p', 'Update README', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.proposalFound, true);
			assert.equal(result.result.applied, false);
			assert.equal(
				await readFile(join(cwd, 'README.md'), 'utf8'),
				'old readme',
			);

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.equal(writes.applied, false);
			assert.match(writes.writes[0].diff, /new readme/u);

			const tasks = JSON.parse(
				await readFile(join(result.result.runDir, 'tasks.json'), 'utf8'),
			);
			assert.equal(
				tasks.tasks.find((task) => task.id === 'edit-readme-md').status,
				'completed',
			);
			assert.equal(result.result.taskCounts.completed, 4);
		} finally {
			await server.close();
		}
	});

	it('records OK envelope messages alongside proposed writes', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'new readme',
								path: 'README.md',
							},
						],
						messages: [
							{
								content: 'Prepared README update.',
								level: 'info',
							},
						],
						status: 'OK',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-envelope-'));
			await writeFile(join(cwd, 'README.md'), 'old readme', 'utf8');

			const result = await main(
				['run', '-p', 'Update README', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.proposalStatus, 'OK');
			assert.equal(result.result.proposalMessageCount, 1);
			assert.deepEqual(
				JSON.parse(
					await readFile(join(result.result.runDir, 'messages.json'), 'utf8'),
				),
				[
					{
						content: 'Prepared README update.',
						level: 'info',
					},
				],
			);
			assert.equal(
				await readFile(join(cwd, 'README.md'), 'utf8'),
				'old readme',
			);
		} finally {
			await server.close();
		}
	});

	it('treats ERROR envelopes as failed runs without applying writes', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						messages: [
							{
								content: 'README.md was not present in context.',
								level: 'error',
							},
						],
						status: 'ERROR',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-error-'));

			const result = await main(
				['run', '-p', 'Update README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(result.result.proposalStatus, 'ERROR');
			assert.match(
				result.result.writeError.message,
				/README\.md was not present/u,
			);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.equal(summary.proposalStatus, 'ERROR');

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.deepEqual(writes.writes, []);
			assert.match(writes.error.message, /README\.md was not present/u);
			assert.deepEqual(
				JSON.parse(
					await readFile(join(result.result.runDir, 'messages.json'), 'utf8'),
				),
				[
					{
						content: 'README.md was not present in context.',
						level: 'error',
					},
				],
			);
		} finally {
			await server.close();
		}
	});

	it('loads memory scopes into run context and records scratchpad artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'ok\n',
								path: 'note.txt',
							},
						],
						scratchpad: 'Next run should keep the repair scoped to one file.',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-memory-'));
			await writeFile(join(cwd, 'KODR_MEMORY.md'), 'Prefer patches.\n', 'utf8');
			await mkdir(join(cwd, '.kodr', 'memory'), { recursive: true });
			await writeFile(
				join(cwd, '.kodr', 'memory', 'user.md'),
				'Keep examples small.\n',
				'utf8',
			);

			const result = await main(
				['run', '-p', 'Use memory.', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			const chatRequest = server.recordings[0].requestBody;
			assert.match(chatRequest.messages[0].content, /Project memory/u);
			assert.match(chatRequest.messages[0].content, /Prefer patches/u);
			assert.match(chatRequest.messages[0].content, /Private user memory/u);
			assert.match(chatRequest.messages[0].content, /Keep examples small/u);
			assert.equal(
				await readFile(join(result.result.runDir, 'scratchpad.md'), 'utf8'),
				'Next run should keep the repair scoped to one file.',
			);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.artifacts.scratchpad, 'scratchpad.md');
		} finally {
			await server.close();
		}
	});

	it('applies extracted proposals with --yes and records tests', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'export {};\n',
								path: 'created.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-apply-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create a module',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'node --check created.mjs',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(result.result.tested, true);
			assert.equal(
				await readFile(join(cwd, 'created.mjs'), 'utf8'),
				'export {};\n',
			);

			const tests = JSON.parse(
				await readFile(join(result.result.runDir, 'tests.json'), 'utf8'),
			);
			assert.equal(tests.ok, true);
		} finally {
			await server.close();
		}
	});

	it('applies extracted patch proposals with --yes', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						patches: [
							{
								path: 'README.md',
								replace: 'hello patched\n',
								search: 'hello\n',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-patch-'));
			await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

			const result = await main(
				['run', '-p', 'Patch README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(
				await readFile(join(cwd, 'README.md'), 'utf8'),
				'hello patched\n',
			);
			assert.equal(result.result.writeResult.writes[0].status, 'patch');
			assert.equal(
				result.result.taskPlan.tasks.find(
					(task) => task.id === 'edit-readme-md',
				).status,
				'completed',
			);
		} finally {
			await server.close();
		}
	});

	it('records failed patch proposals as failed run artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						patches: [
							{
								path: 'README.md',
								replace: 'changed\n',
								search: 'missing\n',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-bad-patch-'));
			await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

			const result = await main(
				['run', '-p', 'Patch README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'hello\n');

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.match(summary.writeError.message, /found 0/u);

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.match(writes.error.message, /found 0/u);

			const tasks = JSON.parse(
				await readFile(join(result.result.runDir, 'tasks.json'), 'utf8'),
			);
			assert.equal(
				tasks.tasks.find((task) => task.id === 'edit-readme-md').status,
				'failed',
			);
		} finally {
			await server.close();
		}
	});

	it('records invalid proposals as failed run artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						patches: [
							{
								path: 'README.md',
								search: 'hello\n',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-invalid-'));
			await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

			const result = await main(
				['run', '-p', 'Patch README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'hello\n');

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.match(summary.proposalError.message, /Proposal patches/u);
			assert.equal(
				await readFile(join(result.result.runDir, 'response.md'), 'utf8'),
				JSON.stringify({
					patches: [
						{
							path: 'README.md',
							search: 'hello\n',
						},
					],
				}),
			);
		} finally {
			await server.close();
		}
	});

	it('does not run verification when apply mode receives no proposal', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponseText('Here is a plain explanation.'),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-missing-'));
			await writeFile(
				join(cwd, 'package.json'),
				'{"type":"module","scripts":{"test":"node --test"}}\n',
				'utf8',
			);

			const result = await main(
				[
					'run',
					'-p',
					'Create a file',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'npm test',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(result.result.proposalFound, false);
			assert.equal(result.result.tested, false);
			assert.match(result.result.writeError.name, /ProposalMissingError/u);

			const tests = JSON.parse(
				await readFile(join(result.result.runDir, 'tests.json'), 'utf8'),
			);
			assert.equal(tests, null);
		} finally {
			await server.close();
		}
	});

	it('runs verification from a jailed test cwd', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: '{"type":"module","scripts":{"test":"node --test"}}\n',
								path: 'example/package.json',
							},
							{
								content:
									"import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\ntest('subproject test', () => assert.equal(1, 1));\n",
								path: 'example/test/example.test.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-test-cwd-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create a subproject',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'npm test',
					'--test-cwd',
					'example',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.testResult.ok, true);
			assert.match(result.result.testResult.stdout, /node --test/u);
			assert.match(
				await readFile(join(cwd, 'example', '.kodr', 'last-test.md'), 'utf8'),
				/node --test/u,
			);
		} finally {
			await server.close();
		}
	});

	it('marks the run failed when verification fails', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const broken = ;\n',
								path: 'example/bad.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-test-fails-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Create a failing subproject',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'node --check bad.mjs',
					'--test-cwd',
					'example',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, false);
			assert.equal(result.result.ok, false);
			assert.equal(result.result.testResult.ok, false);
			assert.match(stdout.text, /^Run failed/u);
		} finally {
			await server.close();
		}
	});

	it('rejects test cwd paths outside the workspace', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [] }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-test-cwd-escape-'));

			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'No writes',
							'--base-url',
							server.baseUrl,
							'--yes',
							'--test',
							'npm test',
							'--test-cwd',
							'..',
						],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/Parent path segments/u,
			);
		} finally {
			await server.close();
		}
	});
});

describe('replay', () => {
	it('prints saved run artifacts as JSON', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-replay-cli-'));
		await mkdir(join(cwd, 'run'), { recursive: true });
		await writeFile(join(cwd, 'run', 'prompt.md'), 'prompt', 'utf8');
		await writeFile(join(cwd, 'run', 'response.md'), 'response', 'utf8');
		await writeFile(join(cwd, 'run', 'summary.json'), '{"ok":true}\n', 'utf8');
		await writeFile(
			join(cwd, 'run', 'raw-response.json'),
			'{"responses":[]}\n',
			'utf8',
		);
		const stdout = captureStream();

		const result = await main(['replay', 'run'], {
			cwd,
			env: {},
			stderr: captureStream(),
			stdout,
		});

		assert.equal(result.ok, true);
		assert.equal(JSON.parse(stdout.text).response, 'response');
	});

	it('rejects replay paths outside the workspace', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'kodr-replay-escape-'));
		const cwd = join(parent, 'workspace');
		await mkdir(cwd, { recursive: true });

		await assert.rejects(
			() =>
				main(['replay', '../run'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Parent path segments/u,
		);
	});
});

describe('cycle-review', () => {
	it('runs the cycle review subagent and writes artifacts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycle-review-'));
		await writeFile(join(cwd, 'AGENTS.md'), '- Run tests.\n', 'utf8');
		await writeFile(
			join(cwd, 'chat.md'),
			'User: Make sure examples are Kodr samples before moving on.\n',
			'utf8',
		);
		const stdout = captureStream();

		const result = await main(
			[
				'cycle-review',
				'--transcript-file',
				'chat.md',
				'--out',
				'cycle-review-run',
				'--json',
			],
			{
				cwd,
				env: {},
				stderr: captureStream(),
				stdout,
			},
		);

		assert.equal(result.ok, true);
		assert.equal(result.result.result.findings.length, 1);
		assert.match(stdout.text, /Kodr samples/u);
		assert.match(
			await readFile(
				join(
					cwd,
					'cycle-review-run',
					'subagents',
					'cycle-review',
					'result.json',
				),
				'utf8',
			),
			/Kodr samples/u,
		);

		const summary = JSON.parse(
			await readFile(join(cwd, 'cycle-review-run', 'summary.json'), 'utf8'),
		);
		assert.equal(
			summary.artifacts.subagentResult,
			'subagents/cycle-review/result.json',
		);
	});

	it('rejects missing transcript file', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycle-review-missing-'));

		await assert.rejects(
			() =>
				main(['cycle-review'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/requires --transcript-file/u,
		);
	});
});

describe('prompt versioning', () => {
	it('parseArgs stores --prompt-id value', () => {
		const options = parseArgs(['run', '-p', 'hi', '--prompt-id', 'my-slug']);
		assert.equal(options.promptId, 'my-slug');
	});

	it('parseArgs stores prompt-history id as second positional', () => {
		const options = parseArgs(['prompt-history', 'todo-cli']);
		assert.equal(options.command, 'prompt-history');
		assert.equal(options.promptHistoryId, 'todo-cli');
	});

	it('prompt-history throws CliError when no id is given', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-noid-'));
		await assert.rejects(
			() =>
				main(['prompt-history'], {
					cwd,
					env: {},
					stdout: captureStream(),
				}),
			CliError,
		);
	});

	it('prompt-history returns empty runs when nothing matches', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-empty-'));
		const stdout = captureStream();
		const result = await main(['prompt-history', 'nonexistent'], {
			cwd,
			env: {},
			stdout,
		});
		assert.equal(result.ok, true);
		assert.equal(result.result.runs.length, 0);
		assert.ok(stdout.text.includes('No runs found'));
	});

	it('run records a content-hash promptId in summary.json', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [] }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-hash-'));
			const result = await main(
				['run', '-p', 'Build a todo app', '--base-url', server.baseUrl],
				{ cwd, env: {}, stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.match(summary.promptId, /^[0-9a-f]{8}$/u);
			assert.ok(summary.timestamp);
		} finally {
			await server.close();
		}
	});

	it('run records the --prompt-id override in summary.json', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [] }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-override-'));
			const result = await main(
				[
					'run',
					'-p',
					'Build a notes app',
					'--prompt-id',
					'notes-api-v1',
					'--base-url',
					server.baseUrl,
				],
				{ cwd, env: {}, stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.promptId, 'notes-api-v1');
		} finally {
			await server.close();
		}
	});

	it('run with --prompt-file derives promptId from the filename slug', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [] }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-file-'));
			await writeFile(
				join(cwd, 'todo-cli.md'),
				'Build a Node.js todo CLI',
				'utf8',
			);
			const result = await main(
				['run', '--prompt-file', 'todo-cli.md', '--base-url', server.baseUrl],
				{ cwd, env: {}, stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.promptId, 'todo-cli');
		} finally {
			await server.close();
		}
	});

	it('prompt-history finds runs after kodr run with a named prompt-id', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [] }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-integ-'));
			await main(
				[
					'run',
					'-p',
					'Build a CSV parser',
					'--prompt-id',
					'csv-parser',
					'--base-url',
					server.baseUrl,
				],
				{ cwd, env: {}, stdout: captureStream() },
			);

			const histResult = await main(['prompt-history', 'csv-parser'], {
				cwd,
				env: {},
				stdout: captureStream(),
			});
			assert.equal(histResult.result.runs.length, 1);
			assert.equal(histResult.result.runs[0].promptId, undefined);
			assert.ok(histResult.result.runs[0].runDir);
		} finally {
			await server.close();
		}
	});
});

describe('token usage reporting', () => {
	it('writes usage object to summary.json when server sends usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_usage',
						object: 'chat.completion',
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-usage-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.deepEqual(result.result.usage, {
				completionTokens: 5,
				costUsd: 0,
				promptTokens: 10,
				tokens: 15,
			});

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.deepEqual(summary.usage, {
				completionTokens: 5,
				costUsd: 0,
				promptTokens: 10,
				tokens: 15,
			});
		} finally {
			await server.close();
		}
	});

	it('writes null usage when server omits usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_no_usage',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-no-usage-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.equal(result.result.usage, null);
		} finally {
			await server.close();
		}
	});

	it('shows usage breakdown in non-JSON run output', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_usage_out',
						object: 'chat.completion',
						usage: {
							prompt_tokens: 100,
							completion_tokens: 50,
							total_tokens: 150,
						},
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-usage-out-'));
			const stdout = captureStream();
			await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			assert.match(stdout.text, /Tokens: 150 \(prompt 100 \/ completion 50\)/u);
		} finally {
			await server.close();
		}
	});

	it('prompt-history shows token totals', async () => {
		// Build a fake run dir with a summary that carries usage.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-history-tokens-'));
		const runDir = join(cwd, '.kodr', 'runs', '2026-01-01T00-00-00.000Z');
		await mkdir(runDir, { recursive: true });
		await writeFile(
			join(runDir, 'summary.json'),
			JSON.stringify({
				promptId: 'hello-world',
				model: 'test-model',
				ok: true,
				timestamp: '2026-01-01T00:00:00.000Z',
				finishReasons: ['stop'],
				usage: {
					tokens: 888,
					promptTokens: 600,
					completionTokens: 288,
					costUsd: 0,
				},
			}),
		);

		const stdout = captureStream();
		await main(['prompt-history', 'hello-world'], {
			cwd,
			env: {},
			stderr: captureStream(),
			stdout,
		});

		assert.match(stdout.text, /tokens=888/u);
	});
});

function captureStream() {
	return {
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}

function proposalResponse(value) {
	return proposalResponseText(JSON.stringify(value));
}

function proposalResponseText(content) {
	return {
		choices: [
			{
				finish_reason: 'stop',
				message: {
					content,
					role: 'assistant',
				},
			},
		],
		id: 'chatcmpl_proposal',
		object: 'chat.completion',
	};
}
