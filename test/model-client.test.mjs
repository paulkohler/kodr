import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
	buildChatRequestBody,
	createChatCompletion,
	firstAssistantMessage,
	FirstTokenTimeoutError,
	InterChunkIdleTimeoutError,
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

describe('completion cap request shaping', () => {
	const messages = [{ role: 'user', content: 'hi' }];
	const model = 'test-model';

	// Phase 236: cap is HEAL-ONLY. Tests that assert the cap IS present must carry
	// completionCapMode: 'heal'. Tests for the no-cap paths stay as-is (and the
	// new main-loop regression tests below explicitly prove no cap without the marker).

	it('adds max_tokens when completionReserve is a positive integer (heal turn)', () => {
		const body = { messages, model };
		const request = buildChatRequestBody(
			{ completionReserve: 4096, completionCapMode: 'heal' },
			body,
		);

		assert.equal(request.max_tokens, 4096);
		// Input body must not be mutated
		assert.equal(Object.hasOwn(body, 'max_tokens'), false);
	});

	it('value equals options.completionReserve, not a hardcoded constant (heal turn)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: 2048, completionCapMode: 'heal' },
			{ messages, model },
		);

		assert.equal(request.max_tokens, 2048);
	});

	it('does not add max_tokens when caller body already has max_tokens (heal turn — override wins)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: 4096, completionCapMode: 'heal' },
			{ messages, model, max_tokens: 99 },
		);

		assert.equal(request.max_tokens, 99);
	});

	it('does not add max_tokens when caller body already has max_completion_tokens (heal turn — override wins)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: 4096, completionCapMode: 'heal' },
			{ messages, model, max_completion_tokens: 200 },
		);

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
		assert.equal(request.max_completion_tokens, 200);
	});

	it('does not add max_tokens when completionReserve is unset', () => {
		const request = buildChatRequestBody({}, { messages, model });

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	it('does not add max_tokens when completionReserve is 0 on a heal turn (guards empty-completion footgun)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: 0, completionCapMode: 'heal' },
			{ messages, model },
		);

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	it('does not add max_tokens when completionReserve is negative on a heal turn (keeps cap <= 0 guard regression-proof)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: -1, completionCapMode: 'heal' },
			{ messages, model },
		);

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	it('preserves both caller override keys when present together (heal turn)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: 4096, completionCapMode: 'heal' },
			{ messages, model, max_tokens: 99, max_completion_tokens: 200 },
		);

		assert.equal(request.max_tokens, 99);
		assert.equal(request.max_completion_tokens, 200);
	});

	it('coexists with max_thinking_tokens (heal turn)', () => {
		const request = buildChatRequestBody(
			{
				completionReserve: 4096,
				maxThinkingTokens: 512,
				completionCapMode: 'heal',
			},
			{ messages, model },
		);

		assert.equal(request.max_tokens, 4096);
		assert.equal(request.max_thinking_tokens, 512);
	});

	it('coexists with cache_control (Anthropic remote model, heal turn)', () => {
		const request = buildChatRequestBody(
			{
				provider: 'openrouter',
				promptCache: 'auto',
				completionReserve: 8192,
				completionCapMode: 'heal',
			},
			{ messages, model: 'anthropic/claude-sonnet-4.5' },
		);

		assert.equal(request.max_tokens, 8192);
		assert.deepEqual(request.cache_control, { type: 'ephemeral' });
	});

	it('composition-order invariant: all three injectors produce disjoint keys without clobbering (heal turn)', () => {
		const request = buildChatRequestBody(
			{
				completionReserve: 4096,
				maxThinkingTokens: 512,
				provider: 'openrouter',
				promptCache: 'auto',
				completionCapMode: 'heal',
			},
			{ messages, model: 'anthropic/claude-sonnet-4.5' },
		);

		assert.equal(request.max_tokens, 4096);
		assert.equal(request.max_thinking_tokens, 512);
		assert.deepEqual(request.cache_control, { type: 'ephemeral' });
	});

	// Phase 236 regression tests: main-loop / staged paths must stay UNCAPPED.
	// A positive completionReserve without completionCapMode:'heal' must NOT inject
	// max_tokens — restoring the known-good pre-234 wire shape for the main loop.

	it('main-loop options (no completionCapMode) — no max_tokens even with positive completionReserve', () => {
		// Regression guard: the main loop carries completionReserve from
		// applyModelProfileDefaults but must NOT get max_tokens injected.
		// Phase 234 regressed this; phase 236 fixes it.
		const request = buildChatRequestBody(
			{ completionReserve: 4096 },
			{ messages, model },
		);

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	it('explicit non-heal completionCapMode — no max_tokens (only "heal" triggers the cap)', () => {
		const request = buildChatRequestBody(
			{ completionReserve: 4096, completionCapMode: 'main' },
			{ messages, model },
		);

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	it('heal mode + positive reserve — cap present (focused heal regression guard)', () => {
		// Belt-and-suspenders: ensure the heal path still injects the cap after 236.
		const request = buildChatRequestBody(
			{ completionReserve: 4096, completionCapMode: 'heal' },
			{ messages, model },
		);

		assert.equal(request.max_tokens, 4096);
	});

	it('main-loop bag with maxThinkingTokens gets max_thinking_tokens but NOT max_tokens (applyRequestParameters is marker-independent)', () => {
		// Proves applyRequestParameters is unaffected by the completionCapMode gate.
		const request = buildChatRequestBody(
			{ completionReserve: 4096, maxThinkingTokens: 1024 },
			{ messages, model },
		);

		assert.equal(request.max_thinking_tokens, 1024);
		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	it('heal mode + unset completionReserve — no max_tokens (positive-integer guard still applies on the heal path)', () => {
		// The marker gate passes for heal, but the positive-integer guard must still
		// bail when there is no reserve to cap on. Closes the heal+unset case (the
		// heal+0 and heal+negative cases are covered above).
		const request = buildChatRequestBody(
			{ completionCapMode: 'heal' },
			{ messages, model },
		);

		assert.equal(Object.hasOwn(request, 'max_tokens'), false);
	});

	// NOTE: this suite proves applyCompletionCap RESPONDS to the marker. That the
	// run-pipeline repairOptions bag actually SETS completionCapMode:'heal' (and the
	// main loop does not) is a wiring fact proven LIVE by the phase-236 dogfood,
	// which inspects raw-request.json: max_tokens present on a heal turn, absent on a
	// main-loop turn. A hand-built options bag here cannot catch that wiring no-op.
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

// Phase 126 — inter-chunk idle deadline: a stream that starts then goes silent
// mid-read fails fast with InterChunkIdleTimeoutError instead of hanging until
// the overall request timeout.
describe('inter-chunk idle deadline (phase 126)', () => {
	it('throws InterChunkIdleTimeoutError when the stream stalls after the first token', async () => {
		// First chunk arrives, then the server holds the socket open silently.
		const partial = `data: ${JSON.stringify({
			choices: [{ delta: { content: 'partial' } }],
		})}\n\n`;
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					streamThenStall: partial,
				},
			],
		});

		try {
			await assert.rejects(
				() =>
					createChatCompletion(
						{
							baseUrl: server.baseUrl,
							extraHeaders: {},
							firstTokenTimeoutMs: 5000,
							idleTimeoutMs: 50,
							timeoutMs: 5000,
						},
						{
							messages: [{ role: 'user', content: 'hi' }],
							model: 'test-model',
						},
					),
				(error) => {
					assert.equal(error instanceof InterChunkIdleTimeoutError, true);
					assert.equal(error.timeoutMs, 50);
					assert.match(error.message, /went silent/u);
					return true;
				},
			);
		} finally {
			await server.close();
		}
	});

	it('does not fire on a normal stream that completes within the idle window', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{
							choices: [
								{ delta: { content: 'all good' }, finish_reason: 'stop' },
							],
						},
					]),
				),
			],
		});

		try {
			const response = await createChatCompletion(
				{
					baseUrl: server.baseUrl,
					extraHeaders: {},
					idleTimeoutMs: 1000,
					timeoutMs: 5000,
				},
				{ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' },
			);
			assert.equal(response.body.choices[0].message.content, 'all good');
		} finally {
			await server.close();
		}
	});
});

describe('onToken callback (phase 134)', () => {
	it('calls onToken for each content delta in order', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{ choices: [{ delta: { content: 'hel' }, finish_reason: null }] },
						{ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
					]),
				),
			],
		});

		const tokens = [];
		try {
			await createChatCompletion(
				{
					...streamOptions(server.baseUrl),
					onToken: (text) => tokens.push(text),
				},
				{ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' },
			);
		} finally {
			await server.close();
		}

		assert.deepEqual(tokens, ['hel', 'lo']);
	});

	it('does not call onToken for tool-call fragments (no content)', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{
							choices: [
								{
									delta: {
										tool_calls: [
											{
												index: 0,
												id: 'tc1',
												type: 'function',
												function: { name: 'write_file', arguments: '' },
											},
										],
									},
									finish_reason: 'tool_calls',
								},
							],
						},
					]),
				),
			],
		});

		const tokens = [];
		try {
			await createChatCompletion(
				{
					...streamOptions(server.baseUrl),
					onToken: (text) => tokens.push(text),
				},
				{ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' },
			);
		} finally {
			await server.close();
		}

		assert.equal(tokens.length, 0);
	});

	it('does not break the read when onToken throws', async () => {
		const server = await startFakeModelServer({
			responses: [
				streamResponse(
					sse([
						{
							choices: [{ delta: { content: 'data' }, finish_reason: 'stop' }],
						},
					]),
				),
			],
		});

		let threwInCallback = false;
		let result;
		try {
			result = await createChatCompletion(
				{
					...streamOptions(server.baseUrl),
					onToken: () => {
						threwInCallback = true;
						throw new Error('callback error');
					},
				},
				{ messages: [{ role: 'user', content: 'hi' }], model: 'test-model' },
			);
		} finally {
			await server.close();
		}

		assert.ok(threwInCallback, 'onToken should have been called');
		assert.equal(result.body.choices[0].message.content, 'data');
	});
});
