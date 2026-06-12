import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
	buildChatRequestBody,
	createChatCompletion,
	firstAssistantMessage,
	FirstTokenTimeoutError,
	isOllamaCloudModel,
	ModelClientError,
	shouldUseAnthropicRootCacheControl,
} from '../src/model-client.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

// Build a Server-Sent Events body from a list of chunk objects, terminated by
// the [DONE] sentinel the OpenAI streaming protocol uses.
function sse(chunks) {
	const events = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`);
	events.push('data: [DONE]');
	return `${events.join('\n\n')}\n\n`;
}

function streamResponse(body) {
	return {
		method: 'POST',
		url: '/v1/chat/completions',
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
		body,
	};
}

const streamOptions = (baseUrl) => ({
	baseUrl,
	extraHeaders: {},
	stream: true,
	timeoutMs: 5000,
});

describe('firstAssistantMessage', () => {
	it('falls back to JSON-looking reasoning_content when content is empty', () => {
		const body = {
			choices: [
				{
					message: {
						content: '',
						reasoning_content: '{"status":"OK","files":[]}',
					},
				},
			],
		};

		assert.equal(firstAssistantMessage(body), '{"status":"OK","files":[]}');
	});

	it('does not expose non-JSON reasoning_content as assistant content', () => {
		const body = {
			choices: [
				{
					message: {
						content: '',
						reasoning_content: 'I should think step by step.',
					},
				},
			],
		};

		assert.equal(firstAssistantMessage(body), '');
	});

	it('strips model control token preamble before content', () => {
		const body = {
			choices: [
				{
					message: {
						content:
							'<|channel|>final <|constrain|>json<|message|>```json\n{"status":"OK"}\n```',
					},
				},
			],
		};

		assert.equal(firstAssistantMessage(body), '```json\n{"status":"OK"}\n```');
	});

	it('leaves content unchanged when no control tokens present', () => {
		const body = {
			choices: [[{ message: { content: '{"status":"OK"}' } }][0]],
		};

		assert.equal(firstAssistantMessage(body), '{"status":"OK"}');
	});
});

describe('prompt cache request shaping', () => {
	it('adds root Anthropic cache control for remote Anthropic model ids', () => {
		const body = {
			messages: [{ role: 'user', content: 'hi' }],
			model: 'anthropic/claude-sonnet-4.5',
		};
		const request = buildChatRequestBody(
			{ provider: 'openrouter', promptCache: 'auto' },
			body,
		);

		assert.deepEqual(request.cache_control, { type: 'ephemeral' });
		assert.equal(Object.hasOwn(body, 'cache_control'), false);
	});

	it('does not add prompt cache control for local or disabled requests', () => {
		assert.equal(
			shouldUseAnthropicRootCacheControl(
				{ provider: 'lmstudio' },
				'anthropic/local-test',
			),
			false,
		);
		assert.deepEqual(
			buildChatRequestBody(
				{ provider: 'openrouter', promptCache: 'off' },
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'anthropic/claude-sonnet-4.5',
				},
			),
			{
				messages: [{ role: 'user', content: 'hi' }],
				model: 'anthropic/claude-sonnet-4.5',
			},
		);
	});

	it('detects Ollama cloud model suffixes', () => {
		assert.equal(isOllamaCloudModel('minimax-m3:cloud'), true);
		assert.equal(isOllamaCloudModel('llama3.2'), false);
	});
});

describe('createChatCompletion streaming', () => {
	it('passes opt-in thinking-token caps through request bodies', async () => {
		// Wire always uses SSE now; provide an SSE response.
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});

		try {
			await createChatCompletion(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					maxThinkingTokens: 512,
					timeoutMs: 5000,
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			assert.equal(server.recordings[0].requestBody.max_thinking_tokens, 512);
		} finally {
			await server.close();
		}
	});

	it('sends root cache control on Anthropic remote requests', async () => {
		// Wire always uses SSE now; provide an SSE response.
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});

		try {
			await createChatCompletion(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					provider: 'openrouter',
					promptCache: 'auto',
					timeoutMs: 5000,
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'anthropic/claude-sonnet-4.5',
				},
			);

			assert.deepEqual(server.recordings[0].requestBody.cache_control, {
				type: 'ephemeral',
			});
		} finally {
			await server.close();
		}
	});

	it('stitches streamed content and captures usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'Hello ' } }] },
						{
							choices: [{ delta: { content: 'world' }, finish_reason: 'stop' }],
						},
						{ choices: [], usage: { total_tokens: 4 } },
					]),
				),
			],
		});

		try {
			const response = await createChatCompletion(
				streamOptions(server.baseUrl),
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			const choice = response.body.choices[0];
			assert.equal(choice.message.content, 'Hello world');
			assert.equal(choice.finish_reason, 'stop');
			assert.equal(response.body.usage.total_tokens, 4);
		} finally {
			await server.close();
		}
	});

	it('accumulates streamed tool_calls fragments', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{
							id: 'chatcmpl_s',
							choices: [
								{
									delta: {
										role: 'assistant',
										tool_calls: [
											{
												index: 0,
												id: 'call_1',
												type: 'function',
												function: { name: 'list_files', arguments: '' },
											},
										],
									},
								},
							],
						},
						{
							choices: [
								{
									delta: {
										tool_calls: [{ index: 0, function: { arguments: '{}' } }],
									},
								},
							],
						},
						{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
						{ choices: [], usage: { total_tokens: 8 } },
					]),
				),
			],
		});

		try {
			const response = await createChatCompletion(
				streamOptions(server.baseUrl),
				{
					messages: [{ role: 'user', content: 'list files' }],
					model: 'test-model',
					tools: [],
				},
			);

			const choice = response.body.choices[0];
			assert.equal(choice.finish_reason, 'tool_calls');
			assert.equal(choice.message.tool_calls.length, 1);
			assert.deepEqual(choice.message.tool_calls[0], {
				id: 'call_1',
				type: 'function',
				function: { name: 'list_files', arguments: '{}' },
			});
			assert.equal(response.body.usage.total_tokens, 8);
		} finally {
			await server.close();
		}
	});

	it('requests stream_options.include_usage on streamed calls', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});

		try {
			await createChatCompletion(streamOptions(server.baseUrl), {
				messages: [{ role: 'user', content: 'hi' }],
				model: 'test-model',
			});

			assert.deepEqual(server.recordings[0].requestBody.stream_options, {
				include_usage: true,
			});
		} finally {
			await server.close();
		}
	});

	it('calls onStreamContent for streamed text fragments', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'A' } }] },
						{ choices: [{ delta: { content: 'B' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});
		const chunks = [];

		try {
			await createChatCompletion(
				{
					...streamOptions(server.baseUrl),
					onStreamContent(chunk) {
						chunks.push(chunk);
					},
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			assert.deepEqual(chunks, ['A', 'B']);
		} finally {
			await server.close();
		}
	});
});

describe('createChatCompletion errors', () => {
	it('preserves transport failure details', async () => {
		const server = createServer();
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address();
		await new Promise((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});

		// Connection fails before any data is sent — works regardless of wire mode.
		await assert.rejects(
			() =>
				createChatCompletion(
					{
						baseUrl: `http://127.0.0.1:${port}/v1`,
						extraHeaders: {},
						timeoutMs: 1000,
					},
					{
						messages: [{ role: 'user', content: 'hi' }],
						model: 'test-model',
					},
				),
			(error) => {
				assert.equal(error instanceof ModelClientError, true);
				assert.equal(error.details.phase, 'fetch');
				assert.equal(error.details.method, 'POST');
				assert.equal(error.details.timeoutMs, 1000);
				assert.equal(error.details.requestBodyBytes > 0, true);
				assert.equal(typeof error.details.cause.name, 'string');
				return true;
			},
		);
	});

	it('waits for slow response headers within the configured timeout (wireNoStream)', async () => {
		// This test exercises the --wire-no-stream escape hatch with a non-SSE server.
		const server = createServer((request, response) => {
			request.resume();
			setTimeout(() => {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(
					JSON.stringify({
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'slow ok', role: 'assistant' },
							},
						],
					}),
				);
			}, 75);
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address();

		try {
			const response = await createChatCompletion(
				{
					baseUrl: `http://127.0.0.1:${port}/v1`,
					extraHeaders: {},
					wireNoStream: true,
					timeoutMs: 1000,
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			assert.equal(response.body.choices[0].message.content, 'slow ok');
		} finally {
			await new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});

	it('enforces the configured request timeout while waiting for headers', async () => {
		// Server holds connection open — overall timeoutMs fires regardless of
		// wire mode. The first-token deadline fires first if set lower; use a
		// large firstTokenTimeoutMs so the overall timeout fires instead.
		const server = createServer((request) => {
			request.resume();
		});
		await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address();

		try {
			await assert.rejects(
				() =>
					createChatCompletion(
						{
							baseUrl: `http://127.0.0.1:${port}/v1`,
							extraHeaders: {},
							firstTokenTimeoutMs: 5000,
							timeoutMs: 25,
						},
						{
							messages: [{ role: 'user', content: 'hi' }],
							model: 'test-model',
						},
					),
				(error) => {
					assert.equal(error instanceof ModelClientError, true);
					assert.equal(error.details.cause.code, 'KODR_REQUEST_TIMEOUT');
					assert.equal(error.details.timeoutMs, 25);
					return true;
				},
			);
		} finally {
			await new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
		}
	});
});

// T1: wire always streams
describe('stream-first transport (T1)', () => {
	it('always sends stream:true on the wire regardless of options.stream', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});

		try {
			await createChatCompletion(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					// stream controls display only; wire must still be stream:true
					stream: false,
					timeoutMs: 5000,
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			assert.equal(server.recordings[0].requestBody.stream, true);
			assert.deepEqual(server.recordings[0].requestBody.stream_options, {
				include_usage: true,
			});
		} finally {
			await server.close();
		}
	});

	it('sends stream:false only with wireNoStream flag', async () => {
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
					},
				},
			],
		});

		try {
			await createChatCompletion(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					wireNoStream: true,
					timeoutMs: 5000,
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			// wireNoStream path does not inject stream: true
			assert.equal(server.recordings[0].requestBody.stream, undefined);
		} finally {
			await server.close();
		}
	});

	it('returns transport metadata with wire:stream', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});

		try {
			const response = await createChatCompletion(
				{ baseUrl: server.baseUrl, extraHeaders: {}, timeoutMs: 5000 },
				{ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' },
			);

			assert.equal(response.transport.wire, 'stream');
			assert.equal(typeof response.transport.timeToFirstTokenMs, 'number');
			assert.equal(response.transport.firstTokenRetries, 0);
		} finally {
			await server.close();
		}
	});
});

// T2: first-token deadline
describe('first-token deadline (T2)', () => {
	// Two consecutive stalls: first triggers retry, second fails the run.
	it('throws FirstTokenTimeoutError after two consecutive stalls', async () => {
		const server = await startFakeModelServer({
			responses: [
				{ method: 'POST', url: '/v1/chat/completions', stall: true },
				{ method: 'POST', url: '/v1/chat/completions', stall: true },
			],
		});

		try {
			await assert.rejects(
				() =>
					createChatCompletion(
						{
							baseUrl: server.baseUrl,
							extraHeaders: {},
							firstTokenTimeoutMs: 40,
							timeoutMs: 5000,
						},
						{
							messages: [{ role: 'user', content: 'hi' }],
							model: 'test-model',
						},
					),
				(error) => {
					assert.equal(error instanceof FirstTokenTimeoutError, true);
					assert.equal(error.timeoutMs, 40);
					assert.match(error.message, /no first token after/u);
					return true;
				},
			);
		} finally {
			await server.close();
		}
	});
});

// T3: automatic single retry
describe('first-token retry (T3)', () => {
	it('retries exactly once on stall then succeeds', async () => {
		const server = await startFakeModelServer({
			responses: [
				// First request stalls
				{ method: 'POST', url: '/v1/chat/completions', stall: true },
				// Retry succeeds
				streamResponse(
					sse([
						{
							choices: [
								{ delta: { content: 'retry ok' }, finish_reason: 'stop' },
							],
						},
					]),
				),
			],
		});

		const retries = [];
		try {
			const response = await createChatCompletion(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					firstTokenTimeoutMs: 40,
					timeoutMs: 5000,
					onFirstTokenRetry(error) {
						retries.push(error.timeoutMs);
					},
				},
				{
					messages: [{ role: 'user', content: 'hi' }],
					model: 'test-model',
				},
			);

			assert.equal(response.body.choices[0].message.content, 'retry ok');
			assert.equal(retries.length, 1);
			assert.equal(response.transport.firstTokenRetries, 1);
			// Two recordings: stall + successful retry
			assert.equal(server.recordings.length, 2);
			assert.equal(server.recordings[0].stalled, true);
		} finally {
			await server.close();
		}
	});

	it('fails with FirstTokenTimeoutError on second stall', async () => {
		const server = await startFakeModelServer({
			responses: [
				{ method: 'POST', url: '/v1/chat/completions', stall: true },
				{ method: 'POST', url: '/v1/chat/completions', stall: true },
			],
		});

		try {
			await assert.rejects(
				() =>
					createChatCompletion(
						{
							baseUrl: server.baseUrl,
							extraHeaders: {},
							firstTokenTimeoutMs: 40,
							timeoutMs: 5000,
						},
						{
							messages: [{ role: 'user', content: 'hi' }],
							model: 'test-model',
						},
					),
				(error) => {
					// The second stall also throws FirstTokenTimeoutError
					assert.equal(error instanceof FirstTokenTimeoutError, true);
					return true;
				},
			);
		} finally {
			await server.close();
		}
	});
});
