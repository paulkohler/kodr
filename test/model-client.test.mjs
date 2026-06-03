import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
	createChatCompletion,
	ModelClientError,
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

describe('createChatCompletion streaming', () => {
	it('passes opt-in thinking-token caps through request bodies', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								message: { content: 'ok', role: 'assistant' },
								finish_reason: 'stop',
							},
						],
						id: 'chatcmpl_thinking',
						object: 'chat.completion',
					},
				},
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

		await assert.rejects(
			() =>
				createChatCompletion(
					{
						baseUrl: `http://127.0.0.1:${port}/v1`,
						extraHeaders: {},
						stream: false,
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

	it('waits for slow response headers within the configured timeout', async () => {
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
					stream: false,
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
							stream: false,
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
