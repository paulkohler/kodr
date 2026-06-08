import { readFile } from 'node:fs/promises';
import { inspectWorkspace, findReferences } from './code-inspector.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
} from './model-client.mjs';
import { HookBlockedError } from './hooks.mjs';
import { createLoopBudget, LoopBudgetError } from './loop-budgets.mjs';
import { listContextFiles } from './context-packer.mjs';
import { jailedPath } from './safe-writes.mjs';
import { normalizeModelUsage } from './usage-normalizer.mjs';
import { runVerification } from './verification-runner.mjs';
import { renderHookStopFeedback } from './command-hooks.mjs';
import { applyResponseFormat } from './structured-output.mjs';
import { loadSkillResource } from './skills.mjs';

const MAX_INSPECT_SYMBOLS = 200;
const MAX_INSPECT_REFERENCES = 100;
const MAX_INSPECT_RESULT_BYTES = 8192;

export class ToolCallError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ToolCallError';
	}
}

// Holds named tool definitions (schema + handler) and builds the tools array
// for the API request.
export class ToolRegistry {
	constructor(options = {}) {
		this._tools = new Map();
		this.cwd = options.cwd || '';
		this.hooks = options.hooks || null;
	}

	// Register a tool. Parameters must be a valid JSON Schema object descriptor.
	register(name, { description, parameters, handler }) {
		this._tools.set(name, { description, parameters, handler });
		return this;
	}

	get size() {
		return this._tools.size;
	}

	// Returns the tools array expected by the OpenAI chat completions API.
	toApiTools() {
		return Array.from(this._tools.entries()).map(([name, def]) => ({
			type: 'function',
			function: {
				name,
				description: def.description,
				parameters: def.parameters,
			},
		}));
	}

	// Dispatch a tool call by name. argsJson comes from the model and is untrusted.
	async dispatch(name, argsJson) {
		const def = this._tools.get(name);
		if (!def) {
			throw new ToolCallError(`Unknown tool: ${name}`);
		}

		// Security: model-supplied argument strings must be valid JSON objects.
		// A malformed or non-object payload is rejected before the handler runs.
		let args;
		try {
			args = JSON.parse(argsJson || '{}');
		} catch {
			throw new ToolCallError(`Invalid JSON arguments for tool "${name}"`);
		}
		if (args === null || typeof args !== 'object' || Array.isArray(args)) {
			throw new ToolCallError(
				`Tool arguments must be a JSON object for "${name}"`,
			);
		}

		let activeArgs = args;
		try {
			const pre = await this.hooks?.run('pre_tool_use', {
				cwd: this.cwd,
				input: activeArgs,
				tool: name,
			});
			activeArgs = pre?.payload?.input || activeArgs;
		} catch (error) {
			if (error instanceof HookBlockedError) {
				throw new ToolCallError(error.message);
			}
			throw error;
		}

		const result = await def.handler(activeArgs);
		try {
			const post = await this.hooks?.run('post_tool_use', {
				cwd: this.cwd,
				input: activeArgs,
				result,
				tool: name,
			});
			return post?.payload && Object.hasOwn(post.payload, 'result')
				? post.payload.result
				: result;
		} catch (error) {
			if (error instanceof HookBlockedError) {
				throw new ToolCallError(error.message);
			}
			throw error;
		}
	}
}

// Run a chat completion loop that supports native tool calls (finish_reason:
// "tool_calls"). The model may call tools multiple times before producing a
// final text response. Each tool round counts as a turn against the budget.
export async function completeWithToolCalls(
	options,
	model,
	prompt,
	systemPrompt,
	registry,
	{ initialMessages } = {},
) {
	const budget = createLoopBudget({
		maxCostUsd: options.maxCostUsd,
		maxRetries: options.maxRetries,
		maxTokens: options.maxTokens,
		maxTurns: options.maxTurns,
	});

	const apiTools = registry.toApiTools();
	const responses = [];
	const finishReasons = [];
	const messages = initialMessages
		? [...initialMessages]
		: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt },
			];

	while (true) {
		budget.beforeTurn();

		const chatResponse = await createChatCompletion(
			options,
			applyResponseFormat(
				{
					messages,
					model,
					temperature: 0,
					tools: apiTools,
				},
				options,
			),
		);
		budget.recordUsage(
			normalizeModelUsage(options.provider, chatResponse.body?.usage, {
				maxCostUsd: options.maxCostUsd,
				model,
			}),
		);

		const choice = chatResponse.body?.choices?.[0];
		const finishReason = choice?.finish_reason || '';
		responses.push(chatResponse.body);
		finishReasons.push(finishReason);

		if (finishReason === 'tool_calls') {
			const toolCalls = choice?.message?.tool_calls || [];

			// Append the full assistant message (tool_calls array must be preserved
			// in history for the API to accept the subsequent tool result messages).
			messages.push({
				content: choice?.message?.content ?? null,
				role: 'assistant',
				tool_calls: toolCalls,
			});

			if (toolCalls.length === 0) {
				// Model signalled tool_calls but provided none — treat as stop.
				budget.stop('finish_no_tool_calls');
				return result(finishReasons, budget, responses, messages, '');
			}

			// Dispatch each call and append a tool result message.
			// Errors are returned as content rather than thrown so the model can
			// observe and recover from tool failures.
			for (const toolCall of toolCalls) {
				const toolName = toolCall.function?.name || '';
				const toolArgs = toolCall.function?.arguments || '{}';

				let content;
				try {
					const raw = await registry.dispatch(toolName, toolArgs);
					content =
						typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
				} catch (error) {
					content = JSON.stringify({ error: error.message });
				}

				messages.push({
					content,
					role: 'tool',
					// tool_call_id links this result to the specific call above.
					tool_call_id: toolCall.id,
				});
			}
			continue;
		}

		// Normal finish — run stop hooks before allowing the turn to end.
		const text = firstAssistantMessage(chatResponse.body);
		messages.push({ content: text, role: 'assistant' });
		try {
			await options.hooks?.run('stop', {
				cwd: options.cwd || '',
				finishReason,
				response: text,
			});
		} catch (error) {
			if (error instanceof HookBlockedError) {
				messages.push({
					content: renderHookStopFeedback(error.message),
					role: 'user',
				});
				continue;
			}
			throw error;
		}
		budget.stop(finishReason ? `finish_${finishReason}` : 'finish_unknown');
		return result(finishReasons, budget, responses, messages, text);
	}
}

// Create a registry pre-loaded with workspace-scoped built-in tools.
export function createBuiltinRegistry(cwd, options = {}) {
	const registry = new ToolRegistry({ cwd, hooks: options.hooks || null });

	registry.register('list_files', {
		description: 'List files available in the workspace.',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		handler: async () => listContextFiles(cwd),
	});

	registry.register('read_file', {
		description: 'Read the text content of a workspace file.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path relative to the workspace root.',
				},
			},
			required: ['path'],
			additionalProperties: false,
		},
		// Security: jailedPath prevents the model from escaping the workspace via
		// path traversal (e.g. "../../etc/passwd").
		handler: async ({ path }) => {
			const jailed = await jailedPath(cwd, path);
			return readFile(jailed.absolute, 'utf8');
		},
	});

	registry.register('inspect_symbols', {
		description:
			'Inspect workspace structure. Returns compact symbols with path, name, kind, and line range. Pass path to inspect one file.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Optional path relative to the workspace root.',
				},
			},
			additionalProperties: false,
		},
		handler: async ({ path } = {}) => {
			if (path !== undefined) {
				await jailedPath(cwd, path);
			}
			const index = await inspectWorkspace(cwd);
			const matchingSymbols = index.symbols.filter(
				(symbol) => path === undefined || symbol.path === path,
			);
			const symbols = matchingSymbols
				.slice(0, MAX_INSPECT_SYMBOLS)
				.map((symbol) => ({
					kind: symbol.kind,
					lineEnd: symbol.lineEnd,
					lineStart: symbol.lineStart,
					name: symbol.name,
					path: symbol.path,
				}));
			return boundedInspectionResult({
				limit: MAX_INSPECT_SYMBOLS,
				symbols,
				total: matchingSymbols.length,
				truncated: matchingSymbols.length > symbols.length,
			});
		},
	});

	registry.register('find_references', {
		description:
			'Find compact references to a named symbol across the workspace structure.',
		parameters: {
			type: 'object',
			properties: {
				symbol: {
					type: 'string',
					description: 'Symbol name to search for.',
				},
			},
			required: ['symbol'],
			additionalProperties: false,
		},
		handler: async ({ symbol }) => {
			const index = await inspectWorkspace(cwd);
			const allReferences = findReferences(index, symbol);
			const references = allReferences
				.slice(0, MAX_INSPECT_REFERENCES)
				.map((reference) => ({
					line: reference.line,
					path: reference.path,
					text: reference.text,
				}));
			return boundedInspectionResult({
				limit: MAX_INSPECT_REFERENCES,
				references,
				symbol,
				total: allReferences.length,
				truncated: allReferences.length > references.length,
			});
		},
	});

	registry.register('read_skill_resource', {
		description:
			'Read a declared resource file from a Markdown skill. The resource must be listed under that skill in the system prompt.',
		parameters: {
			type: 'object',
			properties: {
				resource: {
					type: 'string',
					description: 'Resource path exactly as declared by the skill.',
				},
				skill: {
					type: 'string',
					description: 'Skill name or SKILL.md path.',
				},
			},
			required: ['skill', 'resource'],
			additionalProperties: false,
		},
		handler: async ({ resource, skill }) =>
			loadSkillResource(cwd, skill, resource, {
				maxBytes: options.skillResourceBytes,
			}),
	});

	registry.register('run_command', {
		description:
			'Run an allowlisted verification command in the workspace. Supported commands include npm test, npm run test, node --test, and node --check <file>.',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'Allowlisted command to run.',
				},
				timeoutMs: {
					type: 'number',
					description: 'Optional command timeout in milliseconds.',
				},
			},
			required: ['command'],
			additionalProperties: false,
		},
		handler: async ({ command, timeoutMs }) =>
			runVerification(cwd, command, {
				runner: options.commandRunner || null,
				timeoutMs,
			}),
	});

	return registry;
}

function boundedInspectionResult(result) {
	let text = JSON.stringify(result, null, 2);
	if (Buffer.byteLength(text) <= MAX_INSPECT_RESULT_BYTES) {
		return result;
	}
	const marker = '\n"...truncated"';
	const maxPayloadBytes = MAX_INSPECT_RESULT_BYTES - Buffer.byteLength(marker);
	const truncatedText = Buffer.from(text, 'utf8')
		.subarray(0, Math.max(0, maxPayloadBytes))
		.toString('utf8');
	return `${truncatedText}${marker}`;
}

// Catches LoopBudgetError from completeWithToolCalls and re-throws as a plain
// Error so callers don't have to import LoopBudgetError.
export async function safeCompleteWithToolCalls(...args) {
	try {
		return await completeWithToolCalls(...args);
	} catch (error) {
		if (error instanceof LoopBudgetError) {
			throw new ToolCallError(`Tool call loop stopped: ${error.message}`);
		}
		throw error;
	}
}

function result(finishReasons, budget, responses, messages, text) {
	return {
		finishReasons,
		loopBudget: budget.snapshot(),
		messages,
		responses,
		text,
	};
}
