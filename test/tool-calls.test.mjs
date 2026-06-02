import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	completeWithToolCalls,
	createBuiltinRegistry,
	ToolCallError,
	ToolRegistry,
} from '../src/tool-calls.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('ToolRegistry', () => {
	it('registers tools and builds API tools array', () => {
		const registry = new ToolRegistry();
		registry.register('greet', {
			description: 'Say hello.',
			parameters: {
				type: 'object',
				properties: { name: { type: 'string' } },
				required: ['name'],
			},
			handler: async ({ name }) => `Hello, ${name}!`,
		});

		assert.equal(registry.size, 1);

		const apiTools = registry.toApiTools();
		assert.equal(apiTools.length, 1);
		assert.equal(apiTools[0].type, 'function');
		assert.equal(apiTools[0].function.name, 'greet');
		assert.equal(apiTools[0].function.description, 'Say hello.');
		assert.deepEqual(apiTools[0].function.parameters.required, ['name']);
	});

	it('dispatches a tool call and returns the result', async () => {
		const registry = new ToolRegistry();
		registry.register('add', {
			description: 'Add two numbers.',
			parameters: { type: 'object', properties: {} },
			handler: async ({ a, b }) => a + b,
		});

		const result = await registry.dispatch('add', '{"a":2,"b":3}');
		assert.equal(result, 5);
	});

	it('throws ToolCallError for unknown tools', async () => {
		const registry = new ToolRegistry();
		await assert.rejects(() => registry.dispatch('nope', '{}'), ToolCallError);
	});

	it('throws ToolCallError for invalid JSON arguments', async () => {
		const registry = new ToolRegistry();
		registry.register('noop', {
			description: 'Does nothing.',
			parameters: { type: 'object', properties: {} },
			handler: async () => 'ok',
		});
		await assert.rejects(
			() => registry.dispatch('noop', 'not-json'),
			ToolCallError,
		);
	});

	it('throws ToolCallError when arguments are not a JSON object', async () => {
		const registry = new ToolRegistry();
		registry.register('noop', {
			description: 'Does nothing.',
			parameters: { type: 'object', properties: {} },
			handler: async () => 'ok',
		});
		await assert.rejects(
			() => registry.dispatch('noop', '"string"'),
			ToolCallError,
		);
	});
});

describe('createBuiltinRegistry', () => {
	it('provides list_files, read_file, and run_command tools', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-'));
		await writeFile(join(cwd, 'hello.txt'), 'world', 'utf8');
		const registry = createBuiltinRegistry(cwd);

		assert.equal(registry.size, 3);

		const files = await registry.dispatch('list_files', '{}');
		assert.ok(Array.isArray(files));
		assert.ok(files.includes('hello.txt'));

		const content = await registry.dispatch(
			'read_file',
			'{"path":"hello.txt"}',
		);
		assert.equal(content, 'world');
	});

	it('runs allowlisted commands through the injected command runner', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-command-'));
		const registry = createBuiltinRegistry(cwd, {
			commandRunner: async (_cwd, parsed) => ({
				execution: {
					containerName: 'kodr-command',
					environment: 'docker',
				},
				exitCode: 0,
				stderr: '',
				stdout: `ran ${parsed.bin} ${parsed.args.join(' ')}`,
				timedOut: false,
			}),
		});

		const result = await registry.dispatch(
			'run_command',
			'{"command":"node --test","timeoutMs":1000}',
		);

		assert.equal(result.execution.environment, 'docker');
		assert.equal(result.execution.containerName, 'kodr-command');
	});

	it('read_file rejects path traversal outside workspace', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-jail-'));
		const registry = createBuiltinRegistry(cwd);
		await assert.rejects(() =>
			registry.dispatch('read_file', '{"path":"../../etc/passwd"}'),
		);
	});
});

describe('completeWithToolCalls', () => {
	it('dispatches a single tool call then returns final text', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-'));
		await writeFile(join(cwd, 'note.txt'), 'hello', 'utf8');
		const server = await startFakeModelServer({
			responses: [
				// First turn: model calls list_files
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'tool_calls',
								message: {
									content: null,
									role: 'assistant',
									tool_calls: [
										{
											id: 'call_1',
											type: 'function',
											function: { name: 'list_files', arguments: '{}' },
										},
									],
								},
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Second turn: model returns final answer
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'The file is note.txt.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_2',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			const registry = createBuiltinRegistry(cwd);
			const options = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'What files exist?',
				'You are a helpful assistant.',
				registry,
			);

			assert.equal(completion.text, 'The file is note.txt.');
			assert.deepEqual(completion.finishReasons, ['tool_calls', 'stop']);
			assert.equal(completion.responses.length, 2);

			// Verify the tool result message was injected into the conversation
			const toolMsg = completion.messages.find((m) => m.role === 'tool');
			assert.ok(toolMsg);
			assert.equal(toolMsg.tool_call_id, 'call_1');
			assert.ok(toolMsg.content.includes('note.txt'));
		} finally {
			await server.close();
		}
	});

	it('handles multiple tool calls in a single turn', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-multi-'));
		await writeFile(join(cwd, 'a.txt'), 'aaa', 'utf8');
		await writeFile(join(cwd, 'b.txt'), 'bbb', 'utf8');
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'tool_calls',
								message: {
									content: null,
									role: 'assistant',
									tool_calls: [
										{
											id: 'call_a',
											type: 'function',
											function: {
												name: 'read_file',
												arguments: '{"path":"a.txt"}',
											},
										},
										{
											id: 'call_b',
											type: 'function',
											function: {
												name: 'read_file',
												arguments: '{"path":"b.txt"}',
											},
										},
									],
								},
							},
						],
						id: 'chatcmpl_1',
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
								message: { content: 'Read both files.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_2',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			const registry = createBuiltinRegistry(cwd);
			const options = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Read both files.',
				'You are helpful.',
				registry,
			);

			assert.equal(completion.text, 'Read both files.');
			const toolMessages = completion.messages.filter((m) => m.role === 'tool');
			assert.equal(toolMessages.length, 2);
			assert.equal(toolMessages[0].content, 'aaa');
			assert.equal(toolMessages[1].content, 'bbb');
		} finally {
			await server.close();
		}
	});

	it('returns tool error as message content instead of throwing', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-err-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'tool_calls',
								message: {
									content: null,
									role: 'assistant',
									tool_calls: [
										{
											id: 'call_bad',
											type: 'function',
											function: { name: 'unknown_tool', arguments: '{}' },
										},
									],
								},
							},
						],
						id: 'chatcmpl_1',
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
								message: {
									content: 'I could not use that tool.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_2',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		try {
			const registry = createBuiltinRegistry(cwd);
			const options = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Call an unknown tool.',
				'You are helpful.',
				registry,
			);

			// Loop should complete normally; the error went back to the model
			assert.equal(completion.text, 'I could not use that tool.');
			const toolMsg = completion.messages.find((m) => m.role === 'tool');
			assert.ok(toolMsg.content.includes('error'));
		} finally {
			await server.close();
		}
	});

	it('terminates normally after tool use with stop finish reason', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-stop-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'No tools needed.', role: 'assistant' },
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
			const registry = createBuiltinRegistry(cwd);
			const options = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 8,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Simple question.',
				'You are helpful.',
				registry,
			);

			assert.equal(completion.text, 'No tools needed.');
			assert.deepEqual(completion.finishReasons, ['stop']);
			assert.equal(server.recordings.length, 1);
		} finally {
			await server.close();
		}
	});
});
