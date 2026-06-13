import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	completeWithToolCalls,
	createBuiltinRegistry,
	DEFAULT_TOOL_ALIASES,
	mergeProposalWithDraft,
	normalizeToolCallArguments,
	ProposalDraft,
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

	// R4: unknown-tool error feedback steers model toward write_file/edit_file
	// Phase 117: error now names the capture tools rather than the envelope arrays,
	// following the phase-114 lesson (state what to do, not what not to do).
	it('R4: unknown-tool error names valid tools and steers toward write_file/edit_file', async () => {
		// Evidence: gpt-oss called write_file 4–5 times per run; now write_file is
		// registered in the builtin registry, so an unknown tool means something else.
		// This registry has no capture tools registered (bare ToolRegistry), so any
		// completely unknown name still steers.
		const registry = new ToolRegistry();
		registry.register('list_files', {
			description: 'List files.',
			parameters: { type: 'object', properties: {} },
			handler: async () => [],
		});
		registry.register('read_file', {
			description: 'Read a file.',
			parameters: {
				type: 'object',
				properties: { path: { type: 'string' } },
				required: ['path'],
			},
			handler: async () => '',
		});

		// The ToolCallError is what rejects — capture it via try/catch
		let caught;
		try {
			await registry.dispatch('totally_unknown_tool', '{}');
		} catch (e) {
			caught = e;
		}

		assert.ok(caught instanceof ToolCallError, 'should throw ToolCallError');
		assert.ok(
			caught.message.includes('list_files'),
			'error message should name list_files as a valid tool',
		);
		assert.ok(
			caught.message.includes('read_file'),
			'error message should name read_file as a valid tool',
		);
		assert.ok(
			caught.message.includes('write_file') ||
				caught.message.includes('edit_file'),
			'error message should reference the capture tools',
		);
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
	it('provides file, inspection, reference, command, and capture tools', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-builtin-'));
		await writeFile(join(cwd, 'hello.txt'), 'world', 'utf8');
		const registry = createBuiltinRegistry(cwd);

		// Phase 117: write_file and edit_file capture tools added (W1).
		assert.equal(registry.size, 9);
		assert.deepEqual(
			registry
				.toApiTools()
				.map((tool) => tool.function.name)
				.sort(),
			[
				'edit_file',
				'find_references',
				'inspect_symbols',
				'list_files',
				'read_file',
				'read_skill_resource',
				'run_command',
				'run_skill_command',
				'write_file',
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

	// S4: substantial-content no-proposal recovery — one steering message before
	// declaring failure on a stop turn with real content but no proposal envelope.
	it('S4: sends one steer when stop turn has content but no proposal', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-s4-ok-'));
		const fmt = {
			type: 'json_schema',
			json_schema: {
				name: 'kodr_proposal',
				strict: true,
				schema: { type: 'object' },
			},
		};
		const validEnvelope = JSON.stringify({
			status: 'OK',
			files: [{ path: 'out.mjs', content: 'export const x = 1;' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: substantial prose content but no JSON proposal — triggers steer
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content:
										'I will create the file with the required exports. Let me write the implementation.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_prose',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 2: valid proposal envelope returned after steer
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
				// S4 requires the response_format to have been sent (mode != none)
				responseFormat: fmt,
				structuredOutputMode: 'json_schema',
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
			// Two turns: original + steer follow-up
			assert.equal(server.recordings.length, 2);
			// The steer message should appear in the second request
			const secondReq = server.recordings[1].requestBody;
			const steerMsg = secondReq.messages.find(
				(m) =>
					m.role === 'user' &&
					typeof m.content === 'string' &&
					m.content.includes('no JSON proposal envelope was found'),
			);
			assert.ok(steerMsg, 'steer message should appear in second request');
		} finally {
			await server.close();
		}
	});

	it('S4: does not send steer when stop turn has a valid proposal (no false positive)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-s4-has-proposal-'));
		const validEnvelope = JSON.stringify({
			status: 'OK',
			files: [{ path: 'b.mjs', content: 'export const b = 2;' }],
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
				'Write b.mjs.',
				'You are helpful.',
				registry,
			);

			// Only one turn — steer should not fire when a proposal is present
			assert.equal(server.recordings.length, 1);
			assert.equal(completion.text, validEnvelope);
		} finally {
			await server.close();
		}
	});

	it('S4: does not send steer when nudgeEmptyTurn is false', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-s4-no-nudge-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'Just a prose answer, no proposal here.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_prose',
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
				nudgeEmptyTurn: false, // steer disabled
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Just answer.',
				'You are helpful.',
				registry,
			);

			// Only one turn — no steer without nudgeEmptyTurn
			assert.equal(server.recordings.length, 1);
			assert.equal(completion.text, 'Just a prose answer, no proposal here.');
		} finally {
			await server.close();
		}
	});

	it('S4: does not send steer when mode is none (responseFormatForRequest returns null)', async () => {
		// When structuredOutputMode is 'none' (local model default), S4 must not
		// fire even if content is non-empty with no proposal — the model was never
		// told to return JSON, so prose is a valid response.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-s4-mode-none-'));
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'A prose answer with no JSON proposal.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_prose_local',
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
				// structuredOutputMode 'none' means mode=none, so S4 must not fire
				structuredOutputMode: 'none',
				responseFormat: {
					type: 'json_schema',
					json_schema: { name: 'kodr_proposal' },
				},
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Just answer.',
				'You are helpful.',
				registry,
			);

			// Only one turn — S4 must not fire for local mode='none'
			assert.equal(server.recordings.length, 1);
			assert.equal(completion.text, 'A prose answer with no JSON proposal.');
		} finally {
			await server.close();
		}
	});

	it('S4: sends at most one steer even if second response also lacks a proposal', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-s4-once-'));
		const fmt = {
			type: 'json_schema',
			json_schema: {
				name: 'kodr_proposal',
				strict: true,
				schema: { type: 'object' },
			},
		};
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: prose, no proposal — triggers steer
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'I am thinking...', role: 'assistant' },
							},
						],
						id: 'chatcmpl_prose1',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 2: still no proposal — must NOT trigger another steer
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Still thinking...', role: 'assistant' },
							},
						],
						id: 'chatcmpl_prose2',
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
				responseFormat: fmt,
				structuredOutputMode: 'json_schema',
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Write something.',
				'You are helpful.',
				registry,
			);

			// Exactly 2 turns: original + one steer. No third.
			assert.equal(server.recordings.length, 2);
			assert.equal(completion.text, 'Still thinking...');
		} finally {
			await server.close();
		}
	});
});

// devstral empty-arguments normalization (phase-115-validation)
describe('normalizeToolCallArguments', () => {
	it('normalizes empty-string arguments to "{}"', () => {
		// devstral-small-2-2512 emits arguments:"" instead of "{}"
		const input = [
			{
				id: 'call_1',
				type: 'function',
				function: { name: 'list_files', arguments: '' },
			},
		];
		const output = normalizeToolCallArguments(input);
		assert.equal(output[0].function.arguments, '{}');
		// Other fields are preserved
		assert.equal(output[0].id, 'call_1');
		assert.equal(output[0].function.name, 'list_files');
	});

	it('normalizes null/undefined arguments to "{}"', () => {
		const withNull = [
			{ id: 'c', type: 'function', function: { name: 'f', arguments: null } },
		];
		const withUndef = [{ id: 'c', type: 'function', function: { name: 'f' } }];
		assert.equal(
			normalizeToolCallArguments(withNull)[0].function.arguments,
			'{}',
		);
		assert.equal(
			normalizeToolCallArguments(withUndef)[0].function.arguments,
			'{}',
		);
	});

	it('leaves non-empty arguments unchanged', () => {
		const input = [
			{
				id: 'c',
				type: 'function',
				function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
			},
		];
		const output = normalizeToolCallArguments(input);
		assert.equal(output[0].function.arguments, '{"path":"a.txt"}');
	});

	it('handles empty array and non-array without throwing', () => {
		assert.deepEqual(normalizeToolCallArguments([]), []);
		assert.equal(normalizeToolCallArguments(null), null);
		assert.equal(normalizeToolCallArguments(undefined), undefined);
	});

	// Integration: verify the outbound request body does not contain arguments:""
	// when the model emits a tool_call with empty arguments (devstral pattern).
	it('outbound request body has arguments:"{}" when model emits arguments:""', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-tc-devstral-'));
		await writeFile(join(cwd, 'hello.txt'), 'hi', 'utf8');
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: devstral emits tool call with arguments:"" (empty string)
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
											id: 'call_devstral',
											type: 'function',
											function: { name: 'list_files', arguments: '' },
										},
									],
								},
							},
						],
						id: 'chatcmpl_devstral_1',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 2: final answer
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Files listed.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_devstral_2',
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
				'mistralai/devstral-small-2-2512',
				'List files.',
				'You are helpful.',
				registry,
			);

			assert.equal(completion.text, 'Files listed.');

			// The second request body (turn 2) carries the conversation history.
			// The assistant message in that history must have arguments:"{}" not "".
			const secondReq = server.recordings[1].requestBody;
			const assistantMsg = secondReq.messages.find(
				(m) => m.role === 'assistant' && Array.isArray(m.tool_calls),
			);
			assert.ok(
				assistantMsg,
				'assistant message with tool_calls should be in turn-2 history',
			);
			const tc = assistantMsg.tool_calls[0];
			assert.equal(
				tc.function.arguments,
				'{}',
				'empty arguments must be normalized to "{}" in outbound history',
			);
		} finally {
			await server.close();
		}
	});
});

describe('ToolRegistry dispatch - empty arguments', () => {
	it('dispatch treats empty-string arguments as empty object (same as "{}")', async () => {
		const registry = new ToolRegistry();
		let receivedArgs;
		registry.register('noop', {
			description: 'No-op.',
			parameters: { type: 'object', properties: {} },
			handler: async (args) => {
				receivedArgs = args;
				return 'ok';
			},
		});
		// "" and "{}" should both yield an empty object
		await registry.dispatch('noop', '');
		assert.deepEqual(receivedArgs, {});
		await registry.dispatch('noop', '{}');
		assert.deepEqual(receivedArgs, {});
	});
});

// ---------------------------------------------------------------------------
// Phase 117 — W1: ProposalDraft capture units
// ---------------------------------------------------------------------------

describe('ProposalDraft', () => {
	it('is empty on construction', () => {
		const draft = new ProposalDraft();
		assert.ok(draft.isEmpty);
		assert.equal(draft.files.length, 0);
		assert.equal(draft.patches.length, 0);
	});

	it('recordFile returns terse confirmation and marks draft non-empty', () => {
		const draft = new ProposalDraft();
		const msg = draft.recordFile('src/hello.mjs', 'export const x = 1;\n');
		assert.match(msg, /recorded write_file: src\/hello\.mjs/u);
		assert.match(msg, /bytes/u);
		assert.match(msg, /applies when the task completes/u);
		assert.ok(!draft.isEmpty);
	});

	it('recordPatch returns terse confirmation', () => {
		const draft = new ProposalDraft();
		const msg = draft.recordPatch('src/x.mjs', 'old', 'new');
		assert.match(msg, /recorded edit_file: src\/x\.mjs/u);
		assert.match(msg, /applies when the task completes/u);
	});

	it('last-wins per path for write_file', () => {
		const draft = new ProposalDraft();
		draft.recordFile('a.txt', 'first');
		draft.recordFile('b.txt', 'only');
		draft.recordFile('a.txt', 'second');
		assert.equal(draft.files.length, 2);
		const aFile = draft.files.find((f) => f.path === 'a.txt');
		assert.equal(aFile.content, 'second');
	});

	it('patches accumulate in order', () => {
		const draft = new ProposalDraft();
		draft.recordPatch('a.mjs', 'old1', 'new1');
		draft.recordPatch('a.mjs', 'old2', 'new2');
		assert.equal(draft.patches.length, 2);
		assert.equal(draft.patches[0].search, 'old1');
		assert.equal(draft.patches[1].search, 'old2');
	});

	it('recordAlias increments alias hit counts', () => {
		const draft = new ProposalDraft();
		draft.recordAlias('files');
		draft.recordAlias('files');
		draft.recordAlias('create_file');
		assert.deepEqual(draft.aliasHits, { files: 2, create_file: 1 });
	});
});

// ---------------------------------------------------------------------------
// Phase 117 — W1: write_file/edit_file capture tool registration & behavior
// ---------------------------------------------------------------------------

describe('createBuiltinRegistry write_file and edit_file capture tools', () => {
	it('write_file records a file to the draft and returns confirmation', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-wf-'));
		const registry = createBuiltinRegistry(cwd);
		const result = await registry.dispatch(
			'write_file',
			'{"path":"src/app.mjs","content":"export const x = 1;\\n"}',
		);
		assert.match(result, /recorded write_file: src\/app\.mjs/u);
		assert.ok(!registry.proposalDraft.isEmpty);
		assert.equal(registry.proposalDraft.files.length, 1);
		assert.equal(registry.proposalDraft.files[0].path, 'src/app.mjs');
	});

	it('edit_file records a patch to the draft and returns confirmation', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-ef-'));
		const registry = createBuiltinRegistry(cwd);
		const result = await registry.dispatch(
			'edit_file',
			'{"path":"src/a.mjs","search":"old","replace":"new"}',
		);
		assert.match(result, /recorded edit_file: src\/a\.mjs/u);
		assert.equal(registry.proposalDraft.patches.length, 1);
	});

	it('write_file jail violation returns steering error, not a throw', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-wf-jail-'));
		const registry = createBuiltinRegistry(cwd);
		const result = await registry.dispatch(
			'write_file',
			'{"path":"../escape.txt","content":"bad"}',
		);
		// Must return an error JSON string, not throw.
		const parsed = JSON.parse(result);
		assert.ok(parsed.error, 'should have an error key');
		// Draft must be unmodified.
		assert.ok(registry.proposalDraft.isEmpty);
	});

	it('edit_file jail violation returns steering error', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-ef-jail-'));
		const registry = createBuiltinRegistry(cwd);
		const result = await registry.dispatch(
			'edit_file',
			'{"path":"/etc/passwd","search":"root","replace":""}',
		);
		const parsed = JSON.parse(result);
		assert.ok(parsed.error);
	});

	it('write_file last-wins per path across two calls', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-wf-lw-'));
		const registry = createBuiltinRegistry(cwd);
		await registry.dispatch('write_file', '{"path":"a.txt","content":"first"}');
		await registry.dispatch(
			'write_file',
			'{"path":"a.txt","content":"second"}',
		);
		assert.equal(registry.proposalDraft.files.length, 1);
		assert.equal(registry.proposalDraft.files[0].content, 'second');
	});
});

// ---------------------------------------------------------------------------
// Phase 117 — W2: tool alias dispatch
// ---------------------------------------------------------------------------

describe('tool alias dispatch (W2)', () => {
	it('DEFAULT_TOOL_ALIASES ships the expected four entries', () => {
		assert.equal(DEFAULT_TOOL_ALIASES.files, 'write_file');
		assert.equal(DEFAULT_TOOL_ALIASES.create_file, 'write_file');
		assert.equal(DEFAULT_TOOL_ALIASES.str_replace_editor, 'edit_file');
		assert.equal(DEFAULT_TOOL_ALIASES.apply_patch, 'edit_file');
	});

	it('alias resolves to canonical and records a hit', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-alias-'));
		const registry = createBuiltinRegistry(cwd);
		// 'create_file' is aliased to 'write_file'
		const result = await registry.dispatch(
			'create_file',
			'{"path":"new.mjs","content":"// hello\\n"}',
		);
		assert.match(result, /recorded write_file/u);
		assert.equal(registry.proposalDraft.aliasHits.create_file, 1);
	});

	it('unknown tool (not in registry, not an alias) steers via ToolCallError', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-alias-unk-'));
		const registry = createBuiltinRegistry(cwd);
		let caught;
		try {
			await registry.dispatch('totally_made_up_tool', '{}');
		} catch (e) {
			caught = e;
		}
		assert.ok(caught instanceof ToolCallError);
		assert.match(caught.message, /Unknown tool/u);
	});

	it('aliased call with bad argument shape returns steering error', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-alias-shape-'));
		const registry = createBuiltinRegistry(cwd);
		// 'files' → 'write_file' but with no args (devstral empty-args pattern).
		let caught;
		try {
			await registry.dispatch('files', '{}');
		} catch (e) {
			caught = e;
		}
		assert.ok(caught instanceof ToolCallError, 'should throw ToolCallError');
		assert.match(caught.message, /write_file/u);
		assert.match(caught.message, /path/u);
	});
});

// ---------------------------------------------------------------------------
// Phase 117 — W3/W4: mergeProposalWithDraft
// ---------------------------------------------------------------------------

describe('mergeProposalWithDraft (W3/W4)', () => {
	it('W3: synthesizes a proposal when envelope is null and draft is non-empty', () => {
		const draft = new ProposalDraft();
		draft.recordFile('src/a.mjs', 'content A');
		draft.recordPatch('src/b.mjs', 'old', 'new');
		const result = mergeProposalWithDraft(draft, null);
		assert.equal(result.files.length, 1);
		assert.equal(result.patches.length, 1);
		assert.equal(result.status, 'OK');
		assert.match(result.messages[0].content, /captured via write tools/u);
		assert.equal(result._extractionMeta.channels.captured, 2);
		assert.equal(result._extractionMeta.channels.envelope, 0);
	});

	it('W3: regression — pure envelope with empty draft returns envelope unchanged', () => {
		const draft = new ProposalDraft(); // empty
		const envelope = {
			files: [{ path: 'x.mjs', content: 'ok' }],
			patches: [],
			messages: [],
			scratchpad: '',
			status: 'OK',
		};
		const result = mergeProposalWithDraft(draft, envelope);
		// Pure envelope path — result IS the envelope (reference or equivalent)
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].path, 'x.mjs');
	});

	it('W4: envelope wins per path when both draft and envelope present', () => {
		const draft = new ProposalDraft();
		draft.recordFile('shared.mjs', 'captured version');
		draft.recordFile('draft-only.mjs', 'only in draft');
		const envelope = {
			files: [{ path: 'shared.mjs', content: 'envelope version' }],
			patches: [],
			messages: [{ level: 'info', content: 'done' }],
			scratchpad: 'plan',
			status: 'OK',
			_extractionMeta: { candidateCount: 1, proposalCount: 1, merged: false },
		};
		const result = mergeProposalWithDraft(draft, envelope);
		assert.equal(result.files.length, 2);
		const shared = result.files.find((f) => f.path === 'shared.mjs');
		assert.equal(shared.content, 'envelope version', 'envelope should win');
		assert.equal(result.messages[0].content, 'done');
		assert.equal(result.scratchpad, 'plan');
		assert.equal(result._extractionMeta.channels.captured, 2);
		assert.equal(result._extractionMeta.channels.envelope, 1);
	});

	it('W4: captured patches precede envelope patches in merged result', () => {
		const draft = new ProposalDraft();
		draft.recordPatch('a.mjs', 'old', 'new');
		const envelope = {
			files: [],
			patches: [{ path: 'b.mjs', search: 'x', replace: 'y' }],
			messages: [],
			scratchpad: '',
			status: 'OK',
		};
		const result = mergeProposalWithDraft(draft, envelope);
		assert.equal(result.patches.length, 2);
		assert.equal(result.patches[0].path, 'a.mjs');
		assert.equal(result.patches[1].path, 'b.mjs');
	});

	it('W4: null draft falls back to pure envelope (no crash)', () => {
		const envelope = {
			files: [{ path: 'z.mjs', content: 'body' }],
			patches: [],
			messages: [],
			scratchpad: '',
			status: 'OK',
		};
		const result = mergeProposalWithDraft(null, envelope);
		// null draft treated same as empty draft (pure envelope).
		assert.equal(result.files.length, 1);
	});
});

// ---------------------------------------------------------------------------
// Phase 117 — W3 loop integration: draft → synthesized proposal, F1 skipped
// ---------------------------------------------------------------------------

describe('completeWithToolCalls with capture draft (W3)', () => {
	it('synthesizes proposal from write_file calls when model stops without envelope', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-draft-loop-'));
		const server = await startFakeModelServer({
			responses: [
				// Turn 1: model calls write_file
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
											id: 'call_wf1',
											type: 'function',
											function: {
												name: 'write_file',
												arguments:
													'{"path":"src/hello.mjs","content":"export const x = 1;\\n"}',
											},
										},
									],
								},
							},
						],
						id: 'chatcmpl_wf1',
						object: 'chat.completion',
					},
					status: 200,
				},
				// Turn 2: model stops (no envelope)
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
						id: 'chatcmpl_wf2',
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
				'Create src/hello.mjs',
				'You are helpful.',
				registry,
			);

			// Draft must be non-empty and accessible on the completion result.
			assert.ok(completion.proposalDraft !== null);
			assert.ok(!completion.proposalDraft.isEmpty);
			assert.equal(completion.proposalDraft.files.length, 1);
			assert.equal(completion.proposalDraft.files[0].path, 'src/hello.mjs');
		} finally {
			await server.close();
		}
	});

	it('F1 final-turn is skipped when draft is non-empty (W3)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-f1-skip-'));
		// maxTurns=2: with an empty draft, the second turn would be F1 (no tools).
		// With a non-empty draft, F1 should be skipped and tools still offered.
		const serverResponses = [
			// Turn 1: model calls write_file (draft becomes non-empty)
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
										id: 'call_f1',
										type: 'function',
										function: {
											name: 'write_file',
											arguments: '{"path":"x.mjs","content":"1"}',
										},
									},
								],
							},
						},
					],
					id: 'chatcmpl_f1_1',
					object: 'chat.completion',
				},
				status: 200,
			},
			// Turn 2: model stops normally (not forced final).
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
					id: 'chatcmpl_f1_2',
					object: 'chat.completion',
				},
				status: 200,
			},
		];
		const server = await startFakeModelServer({ responses: serverResponses });

		try {
			const registry = createBuiltinRegistry(cwd);
			const options = {
				baseUrl: server.baseUrl,
				extraHeaders: {},
				maxCostUsd: '',
				maxRetries: 7,
				maxTokens: '',
				maxTurns: 2,
				stream: false,
				timeoutMs: 5000,
			};

			const completion = await completeWithToolCalls(
				options,
				'test-model',
				'Create x.mjs',
				'You are helpful.',
				registry,
			);

			// Second request (turn 2) should still include tools (F1 was skipped).
			const secondReq = server.recordings[1].requestBody;
			assert.ok(
				Array.isArray(secondReq.tools) && secondReq.tools.length > 0,
				'F1 should be skipped when draft is non-empty — tools should be present in turn 2',
			);
			assert.ok(!completion.proposalDraft.isEmpty);
		} finally {
			await server.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Phase 117 — streamed tool-call fragment reassembly with large content arg
// ---------------------------------------------------------------------------

describe('normalizeToolCallArguments with large content (W1 regression)', () => {
	it('handles a multi-KB content argument in a tool_call arguments string', () => {
		// Simulate SSE reassembly yielding a write_file call with a large file body.
		const largeContent = 'x'.repeat(8000); // 8 KB
		const args = JSON.stringify({ path: 'big.txt', content: largeContent });
		const toolCalls = [
			{
				id: 'call_large',
				type: 'function',
				function: { name: 'write_file', arguments: args },
			},
		];
		const normalized = normalizeToolCallArguments(toolCalls);
		assert.equal(normalized.length, 1);
		// Arguments string must be preserved intact (not truncated).
		const parsed = JSON.parse(normalized[0].function.arguments);
		assert.equal(parsed.content.length, 8000);
		assert.equal(parsed.path, 'big.txt');
	});
});
