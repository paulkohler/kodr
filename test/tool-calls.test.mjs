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
import { mkdir, writeFile as writeFileFs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfiguredHooks } from '../src/command-hooks.mjs';
import { createHooks } from '../src/hooks.mjs';
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

	it('runs post tool hooks after native tool dispatch', async () => {
		const observed = [];
		const registry = new ToolRegistry({
			hooks: createHooks({
				post_tool_use: [
					(payload) => {
						observed.push(`${payload.tool}:${payload.result}`);
					},
				],
			}),
		});
		registry.register('add', {
			description: 'Add two numbers.',
			parameters: { type: 'object', properties: {} },
			handler: async ({ a, b }) => a + b,
		});

		assert.equal(await registry.dispatch('add', '{"a":2,"b":3}'), 5);
		assert.deepEqual(observed, ['add:5']);
	});

	it('turns post tool hook blocks into tool call errors', async () => {
		const registry = new ToolRegistry({
			hooks: createHooks({
				post_tool_use: [
					() => ({ action: 'block', reason: 'post hook blocked' }),
				],
			}),
		});
		registry.register('add', {
			description: 'Add two numbers.',
			parameters: { type: 'object', properties: {} },
			handler: async ({ a, b }) => a + b,
		});

		await assert.rejects(
			() => registry.dispatch('add', '{"a":2,"b":3}'),
			/post hook blocked/u,
		);
	});

	it('blocks destructive tool calls before the effect runs (PreToolUse)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-pre-hook-'));
		const configPath = join(cwd, '.kodr/hooks.json');
		await mkdir(dirname(configPath), { recursive: true });
		await writeFileFs(
			configPath,
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{
							hooks: [
								{
									args: [
										'-e',
										"process.stdout.write(JSON.stringify({decision:'block', reason:'rm blocked'}));",
									],
									command: process.execPath,
									if: 'run_command(rm *)',
									type: 'command',
								},
							],
							matcher: 'run_command',
						},
					],
				},
			}),
			'utf8',
		);
		const configured = await loadConfiguredHooks(cwd, { enableHooks: true });

		let effects = 0;
		const registry = new ToolRegistry({ cwd, hooks: configured.hooks });
		registry.register('run_command', {
			description: 'Run a command.',
			parameters: { type: 'object', properties: {} },
			handler: async () => {
				effects += 1;
				return 'ran';
			},
		});

		await assert.rejects(
			() => registry.dispatch('run_command', '{"command":"rm file.txt"}'),
			/rm blocked/u,
		);
		// The PreToolUse block must prevent the handler effect entirely.
		assert.equal(effects, 0);

		// A non-matching command still runs the handler.
		assert.equal(
			await registry.dispatch('run_command', '{"command":"npm test"}'),
			'ran',
		);
		assert.equal(effects, 1);
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
	it('provides file, inspection, reference, and command tools', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-'));
		await writeFile(join(cwd, 'hello.txt'), 'world', 'utf8');
		const registry = createBuiltinRegistry(cwd);

		assert.equal(registry.size, 7);
		assert.deepEqual(
			registry
				.toApiTools()
				.map((tool) => tool.function.name)
				.sort(),
			[
				'find_references',
				'inspect_symbols',
				'list_files',
				'read_file',
				'read_skill_resource',
				'run_command',
				'run_skill_command',
			],
		);

		const files = await registry.dispatch('list_files', '{}');
		assert.ok(Array.isArray(files));
		assert.ok(files.includes('hello.txt'));

		const content = await registry.dispatch(
			'read_file',
			'{"path":"hello.txt"}',
		);
		assert.equal(content, 'world');
	});

	it('read_skill_resource loads only declared skill resources', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-skill-resource-'));
		await mkdir(join(cwd, 'skills', 'edit', 'docs'), { recursive: true });
		await writeFile(
			join(cwd, 'skills', 'edit', 'SKILL.md'),
			[
				'---',
				'name: editor',
				'resources:',
				'  - path: docs/patches.md',
				'    description: Patch examples',
				'---',
				'Use patches.',
			].join('\n'),
			'utf8',
		);
		await writeFile(
			join(cwd, 'skills', 'edit', 'docs', 'patches.md'),
			'patch reference body',
			'utf8',
		);
		const registry = createBuiltinRegistry(cwd);

		const result = await registry.dispatch(
			'read_skill_resource',
			'{"skill":"editor","resource":"docs/patches.md"}',
		);

		assert.equal(result.skill, 'editor');
		assert.equal(result.description, 'Patch examples');
		assert.equal(result.content, 'patch reference body');
		await assert.rejects(() =>
			registry.dispatch(
				'read_skill_resource',
				'{"skill":"editor","resource":"../secret.md"}',
			),
		);
	});

	it('run_skill_command requires approval and sandbox execution', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-skill-command-'));
		await mkdir(join(cwd, 'skills', 'tools', 'scripts'), { recursive: true });
		await writeFile(
			join(cwd, 'skills', 'tools', 'SKILL.md'),
			[
				'---',
				'name: tools',
				'commands:',
				'  - name: summarize',
				'    path: scripts/summarize.mjs',
				'---',
				'Use helpers.',
			].join('\n'),
			'utf8',
		);
		await writeFile(
			join(cwd, 'skills', 'tools', 'scripts', 'summarize.mjs'),
			'console.log("summary");',
			'utf8',
		);
		const calls = [];
		const registry = createBuiltinRegistry(cwd, {
			permissionApprover: async () => ({ decision: 'allow' }),
			skillExecutor: {
				backend: 'docker',
				run: async (runCwd, parsed, timeoutMs, options) => {
					calls.push({ options, parsed, runCwd, timeoutMs });
					return {
						exitCode: 0,
						execution: { environment: 'docker' },
						stderr: '',
						stdout: 'summary\n',
						timedOut: false,
					};
				},
			},
			timeoutMs: 1000,
		});

		const result = await registry.dispatch(
			'run_skill_command',
			'{"skill":"tools","command":"summarize"}',
		);

		assert.equal(result.ok, true);
		assert.equal(result.stdout, 'summary\n');
		assert.equal(calls[0].parsed.bin, 'node');
		assert.equal(calls[0].options.readOnlyWorkspace, true);
		assert.equal(calls[0].options.network, 'none');
	});

	it('inspect_symbols returns compact workspace symbols', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-symbols-'));
		await writeFile(
			join(cwd, 'src.mjs'),
			[
				'export function alpha() {',
				'  return beta();',
				'}',
				'export const beta = () => 1;',
			].join('\n'),
			'utf8',
		);
		const registry = createBuiltinRegistry(cwd);

		const result = await registry.dispatch('inspect_symbols', '{}');

		assert.equal(result.total, 2);
		assert.equal(result.truncated, false);
		assert.deepEqual(
			result.symbols.map((symbol) => ({
				kind: symbol.kind,
				name: symbol.name,
				path: symbol.path,
			})),
			[
				{ kind: 'function', name: 'alpha', path: 'src.mjs' },
				{ kind: 'function', name: 'beta', path: 'src.mjs' },
			],
		);
		assert.equal(Object.hasOwn(result.symbols[0], 'content'), false);
	});

	it('inspect_symbols scopes to a jailed file path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-symbol-path-'));
		await writeFile(join(cwd, 'a.mjs'), 'export function alpha() {}', 'utf8');
		await writeFile(join(cwd, 'b.mjs'), 'export function beta() {}', 'utf8');
		const registry = createBuiltinRegistry(cwd);

		const result = await registry.dispatch(
			'inspect_symbols',
			'{"path":"b.mjs"}',
		);

		assert.deepEqual(
			result.symbols.map((symbol) => symbol.name),
			['beta'],
		);
		await assert.rejects(() =>
			registry.dispatch('inspect_symbols', '{"path":"../../etc/passwd"}'),
		);
	});

	it('find_references returns compact bounded references', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-refs-'));
		await writeFile(
			join(cwd, 'src.mjs'),
			[
				'export function alpha() {',
				'  return beta();',
				'}',
				'export function beta() {',
				'  return 1;',
				'}',
			].join('\n'),
			'utf8',
		);
		const registry = createBuiltinRegistry(cwd);

		const result = await registry.dispatch(
			'find_references',
			'{"symbol":"beta"}',
		);

		assert.equal(result.symbol, 'beta');
		assert.equal(result.total, 2);
		assert.deepEqual(
			result.references.map((reference) => reference.line),
			[2, 4],
		);
	});

	it('inspection tools cap large result counts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-large-refs-count-'));
		await writeFile(
			join(cwd, 'refs.mjs'),
			Array.from({ length: 120 }, () => 't();').join('\n'),
			'utf8',
		);
		const registry = createBuiltinRegistry(cwd);

		const result = await registry.dispatch('find_references', '{"symbol":"t"}');

		assert.equal(result.references.length, 100);
		assert.equal(result.total, 120);
		assert.equal(result.truncated, true);
	});

	it('inspection tools cap serialized JSON output', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-large-refs-'));
		await writeFile(
			join(cwd, 'refs.mjs'),
			Array.from(
				{ length: 120 },
				(_, index) =>
					`const value${index} = targetSymbol("${'x'.repeat(200)}");`,
			).join('\n'),
			'utf8',
		);
		const registry = createBuiltinRegistry(cwd);

		const result = await registry.dispatch(
			'find_references',
			'{"symbol":"targetSymbol"}',
		);

		assert.equal(typeof result, 'string');
		assert.ok(Buffer.byteLength(result) <= 8192);
		assert.match(result, /"\.\.\.truncated"/u);
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

	// F1 tests
	it('F1 steering: appends hint when run_command rejects non-allowlisted command', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-steering-'));
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
											id: 'call_sed',
											type: 'function',
											function: {
												name: 'run_command',
												arguments: '{"command":"sed -i s/a/b/ file.js"}',
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
								message: { content: '{"files":[]}', role: 'assistant' },
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
				'Fix the bug.',
				'You are helpful.',
				registry,
			);

			const toolMsg = completion.messages.find(
				(m) => m.role === 'tool' && m.tool_call_id === 'call_sed',
			);
			assert.ok(toolMsg, 'tool result message should exist');
			const parsed = JSON.parse(toolMsg.content);
			assert.ok(
				typeof parsed.hint === 'string' && parsed.hint.includes('files array'),
				'hint should mention files array',
			);
		} finally {
			await server.close();
		}
	});

	it('F1 repeat-call: skips execution and returns synthetic result on duplicate call', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-repeat-'));
		await writeFile(join(cwd, 'a.txt'), 'content', 'utf8');
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: list_files
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
				// Turn 2: same list_files again (repeat)
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
											id: 'call_2',
											type: 'function',
											function: { name: 'list_files', arguments: '{}' },
										},
									],
								},
							},
						],
						id: 'chatcmpl_2',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 3: final answer
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '{"files":[]}', role: 'assistant' },
							},
						],
						id: 'chatcmpl_3',
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
				'List files.',
				'You are helpful.',
				registry,
			);

			const repeatMsg = completion.messages.find(
				(m) => m.role === 'tool' && m.tool_call_id === 'call_2',
			);
			assert.ok(repeatMsg, 'tool result for repeat call should exist');
			const parsed = JSON.parse(repeatMsg.content);
			assert.equal(parsed.repeat, true, 'repeat field should be true');
			assert.ok(
				typeof parsed.message === 'string',
				'synthetic message should be present',
			);
		} finally {
			await server.close();
		}
	});

	it('F1 final-turn forcing: last turn omits tools and adds user message', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-final-turn-'));
		const server = await startFakeModelServer({
			responses: [
				// Turn 1 (final): model returns stop without tools
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '{"files":[]}', role: 'assistant' },
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
				maxTurns: 1,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Do the work.',
				'You are helpful.',
				registry,
			);

			assert.equal(completion.text, '{"files":[]}');
			// The request sent to the server must not include a tools array
			const request = server.recordings[0].requestBody;
			assert.equal(
				Object.hasOwn(request, 'tools'),
				false,
				'final-turn request must not have tools',
			);
			// And the appended user message should mention the budget
			const userMsg = request.messages.at(-1);
			assert.equal(userMsg.role, 'user');
			assert.ok(
				userMsg.content.toLowerCase().includes('budget') ||
					userMsg.content.toLowerCase().includes('exhausted'),
				'user message should mention budget exhaustion',
			);
		} finally {
			await server.close();
		}
	});

	// F2 test
	it('F2 salvage: returns accumulated responses on LoopBudgetError instead of throwing', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-budget-'));
		await writeFile(join(cwd, 'x.txt'), 'x', 'utf8');
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: tool call
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
				// Turn 2: another tool call (budget exhausted after this — maxTurns=2
				// but we need maxTurns=1 with a tool call on turn 1 to exhaust it
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
				maxTurns: 1,
				stream: false,
				timeoutMs: 5000,
			};

			// With maxTurns=1, the final-turn forcing kicks in for turn 1, so we
			// need maxTurns=0 to trigger the beforeTurn LoopBudgetError path.
			// Use maxTurns=0 which hits budget immediately.
			const opts0 = { ...options, maxTurns: 0 };
			const completion = await completeWithToolCalls(
				opts0,
				'test-model',
				'Do work.',
				'You are helpful.',
				registry,
			);

			// Should return a result shape, not throw
			assert.ok(completion, 'should return completion object');
			assert.ok(Array.isArray(completion.responses));
			assert.ok(Array.isArray(completion.finishReasons));
			assert.ok(Array.isArray(completion.messages));
			assert.ok(completion.loopBudget);
			assert.equal(typeof completion.text, 'string');
		} finally {
			await server.close();
		}
	});

	it('feeds stop hook block reasons back into the model loop', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-stop-hook-'));
		let stopCalls = 0;
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'First answer.', role: 'assistant' },
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
								message: { content: 'Fixed answer.', role: 'assistant' },
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
				cwd,
				extraHeaders: {},
				hooks: createHooks({
					stop: [
						() => {
							stopCalls += 1;
							return stopCalls === 1
								? { action: 'block', reason: 'npm test failed' }
								: {};
						},
					],
				}),
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

			assert.equal(completion.text, 'Fixed answer.');
			assert.deepEqual(completion.finishReasons, ['stop', 'stop']);
			assert.equal(server.recordings.length, 2);
			const second = server.recordings[1].requestBody;
			assert.match(second.messages.at(-1).content, /npm test failed/u);
		} finally {
			await server.close();
		}
	});

	// E4: empty-final-turn recovery — exactly one nudge retry on near-empty stop
	it('E4: sends one nudge when stop turn is near-empty, then succeeds on valid reply', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-e4-ok-'));
		const validEnvelope = JSON.stringify({
			status: 'OK',
			files: [{ path: 'out.mjs', content: 'export const x = 1;' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: near-empty stop — triggers the nudge
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '\n\n', role: 'assistant' },
							},
						],
						id: 'chatcmpl_empty',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 2: valid proposal envelope — returned after nudge
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: validEnvelope, role: 'assistant' },
							},
						],
						id: 'chatcmpl_valid',
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
				nudgeEmptyTurn: true,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Write out.mjs.',
				'You are helpful.',
				registry,
			);

			assert.equal(completion.text, validEnvelope);
			// Two turns: original + nudge follow-up
			assert.equal(server.recordings.length, 2);
			// The nudge message should appear in the second request
			const secondReq = server.recordings[1].requestBody;
			const nudgeMsg = secondReq.messages.find(
				(m) =>
					m.role === 'user' &&
					typeof m.content === 'string' &&
					m.content.includes('Your last message was empty'),
			);
			assert.ok(nudgeMsg, 'nudge message should appear in second request');
		} finally {
			await server.close();
		}
	});

	it('E4: does not send a second nudge when first nudge also returns empty (exactly one retry)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-e4-fail-'));
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: near-empty stop
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '  ', role: 'assistant' },
							},
						],
						id: 'chatcmpl_empty1',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 2: still near-empty after nudge — must NOT trigger another nudge
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '{}', role: 'assistant' },
							},
						],
						id: 'chatcmpl_empty2',
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
				nudgeEmptyTurn: true,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Do something.',
				'You are helpful.',
				registry,
			);

			// Should stop after exactly 2 turns (original + one nudge), not loop
			assert.equal(server.recordings.length, 2);
			// The text from turn 2 is returned as final
			assert.equal(completion.text, '{}');
		} finally {
			await server.close();
		}
	});

	it('E4: does not nudge when stop turn has a valid proposal', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-e4-has-proposal-'));
		const validEnvelope = JSON.stringify({
			status: 'OK',
			files: [{ path: 'a.mjs', content: 'export const a = 1;' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: validEnvelope, role: 'assistant' },
							},
						],
						id: 'chatcmpl_ok',
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
				nudgeEmptyTurn: true,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Write a.mjs.',
				'You are helpful.',
				registry,
			);

			// Only one turn — no nudge needed
			assert.equal(server.recordings.length, 1);
			assert.equal(completion.text, validEnvelope);
		} finally {
			await server.close();
		}
	});
});
