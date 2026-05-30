import { readFile } from 'node:fs/promises';
import { createChatCompletion } from './model-client.mjs';
import { createLoopBudget, LoopBudgetError } from './loop-budgets.mjs';
import { listContextFiles } from './context-packer.mjs';
import { jailedPath } from './safe-writes.mjs';
import { normalizeModelUsage } from './usage-normalizer.mjs';

export class ToolCallError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ToolCallError';
	}
}

// Holds named tool definitions (schema + handler) and builds the tools array
// for the API request.
export class ToolRegistry {
	constructor() {
		this._tools = new Map();
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

		return def.handler(args);
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

		const chatResponse = await createChatCompletion(options, {
			messages,
			model,
			temperature: 0,
			tools: apiTools,
		});
		budget.recordUsage(
			normalizeModelUsage(options.provider, chatResponse.body?.usage, {
				maxCostUsd: options.maxCostUsd,
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

		// Normal finish — append the final assistant turn to complete the
		// transcript, then return.
		const text = choice?.message?.content || '';
		messages.push({ content: text, role: 'assistant' });
		budget.stop(finishReason ? `finish_${finishReason}` : 'finish_unknown');
		return result(finishReasons, budget, responses, messages, text);
	}
}

// Create a registry pre-loaded with workspace-scoped built-in tools.
export function createBuiltinRegistry(cwd) {
	const registry = new ToolRegistry();

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

	return registry;
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
