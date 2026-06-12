import { readFile } from 'node:fs/promises';
import { inspectWorkspace, findReferences } from './repomap/index.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
	summarizeTransportFacts,
} from './model-client.mjs';
import { HookBlockedError } from './hooks.mjs';
import { createLoopBudget, LoopBudgetError } from './loop-budgets.mjs';
import { listContextFiles } from './context-packer.mjs';
import { jailedPath } from './safe-writes.mjs';
import { normalizeModelUsage } from './usage-normalizer.mjs';
import { runVerification } from './verification-runner.mjs';
import { renderHookStopFeedback } from './command-hooks.mjs';
import {
	applyResponseFormat,
	responseFormatForRequest,
} from './structured-output.mjs';
import { loadSkillResource } from './skills.mjs';
import { runSkillCommand } from './skill-execution.mjs';
import { extractProposal } from './json-extractor.mjs';

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
			const validTools = Array.from(this._tools.keys()).join(', ');
			throw new ToolCallError(
				`Unknown tool: ${name}. Valid tools: ${validTools}. ` +
					'There is no write tool — file changes go in the files/patches arrays of the final JSON envelope.',
			);
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
	const transportFacts = [];
	const messages = initialMessages
		? [...initialMessages]
		: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: prompt },
			];

	// Track tool calls seen this run to short-circuit exact repeats.
	const seenToolCalls = new Map();
	// E4: track whether we have already sent the empty-turn nudge so it fires
	// exactly once and cannot become a loop.
	let nudgeSent = false;
	// S4: track whether we have already sent the no-proposal steer so it fires
	// exactly once (the steer is cheaper than a full repair loop).
	let noProposalSteerSent = false;

	while (true) {
		// F2: catch LoopBudgetError from beforeTurn and return salvaged completion
		// rather than propagating, so accumulated messages/responses are not lost.
		try {
			budget.beforeTurn();
		} catch (error) {
			if (error instanceof LoopBudgetError) {
				const lastText = lastAssistantText(messages);
				budget.stop('turn_budget_exhausted');
				return result(
					finishReasons,
					budget,
					responses,
					messages,
					lastText,
					transportFacts,
				);
			}
			throw error;
		}

		// F1 final-turn forcing: when exactly one turn remains, send the request
		// without tools so the model must return a final text answer.
		const isFinalTurn =
			Number.isFinite(budget.state.maxTurns) &&
			budget.state.turns === budget.state.maxTurns;

		const requestBody = applyResponseFormat(
			{
				messages: isFinalTurn
					? [
							...messages,
							{
								content:
									'Turn budget exhausted. Return the final JSON proposal now — do not call any tools.',
								role: 'user',
							},
						]
					: messages,
				model,
				temperature: 0,
				...(isFinalTurn ? {} : { tools: apiTools }),
			},
			options,
		);

		const chatResponse = await createChatCompletion(options, requestBody);
		if (chatResponse.transport) {
			transportFacts.push(chatResponse.transport);
		}
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

		if (!isFinalTurn && finishReason === 'tool_calls') {
			const toolCalls = choice?.message?.tool_calls || [];

			// Append the full assistant message (tool_calls array must be preserved
			// in history for the API to accept the subsequent tool result messages).
			// Normalize outbound tool_calls: some models (e.g. devstral-small-2-2512)
			// emit arguments:"" instead of "{}". LM Studio returns HTTP 500 when the
			// conversation history contains a tool_calls entry with arguments:"".
			// Normalize to "{}" before the message enters history — the raw artifact
			// (raw-response.json) is written from chatResponse.body, not messages, so
			// the model's actual bytes are preserved in artifacts.
			messages.push({
				content: choice?.message?.content ?? null,
				role: 'assistant',
				tool_calls: normalizeToolCallArguments(toolCalls),
			});

			if (toolCalls.length === 0) {
				// Model signalled tool_calls but provided none — treat as stop.
				budget.stop('finish_no_tool_calls');
				return result(
					finishReasons,
					budget,
					responses,
					messages,
					'',
					transportFacts,
				);
			}

			// Dispatch each call and append a tool result message.
			// Errors are returned as content rather than thrown so the model can
			// observe and recover from tool failures.
			for (const toolCall of toolCalls) {
				const toolName = toolCall.function?.name || '';
				const toolArgs = toolCall.function?.arguments || '{}';
				// F1 repeat-call short-circuit: key on name + exact args string.
				const callKey = `${toolName}\0${toolArgs}`;

				let content;
				if (seenToolCalls.has(callKey)) {
					// Identical repeat — skip execution and steer the model back to a proposal.
					content = JSON.stringify({
						repeat: true,
						message:
							'This exact tool call was already made. Stop calling tools and return the final JSON proposal now.',
					});
				} else {
					seenToolCalls.set(callKey, true);
					try {
						const raw = await registry.dispatch(toolName, toolArgs);
						content =
							typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
						// F1 steering: when run_command rejects a non-allowlisted command,
						// append a note reminding the model that file changes go in the
						// proposal's files array, not via shell commands.
						if (
							toolName === 'run_command' &&
							typeof raw === 'object' &&
							raw !== null &&
							typeof raw.error === 'string' &&
							raw.error.startsWith('Command is not allowlisted:')
						) {
							content = JSON.stringify({
								...raw,
								hint: 'The harness has no write tool. Return file changes in the final JSON proposal (files array), not via shell commands.',
							});
						}
					} catch (error) {
						content = JSON.stringify({ error: error.message });
						// F1 steering: propagate the write-via-proposal hint when an allowlist
						// rejection occurs (VerificationError thrown from runVerification).
						if (
							toolName === 'run_command' &&
							typeof error.message === 'string' &&
							error.message.startsWith('Command is not allowlisted:')
						) {
							content = JSON.stringify({
								error: error.message,
								hint: 'The harness has no write tool. Return file changes in the final JSON proposal (files array), not via shell commands.',
							});
						}
					}
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

		// E4: empty-final-turn recovery. When the model returns a stop turn with
		// near-empty content and no extractable proposal, send exactly one nudge
		// before declaring failure. This catches qwen3.6's reasoning-then-silence
		// mode where planning tokens are consumed but content is blank.
		// Only fires when options.nudgeEmptyTurn is true (set by callers that
		// expect a JSON proposal — no-tools main path and no-tools subagent path).
		// The nudge fires only on whitespace-only (zero visible chars) stop turns
		// with no extractable proposal. This precisely targets qwen3.6's
		// reasoning-then-silence mode where the model emits "\n\n" or similar
		// empty content after spending all its tokens in reasoning, without
		// triggering on short but legitimate text answers ("ok", "Done.", etc.).
		if (
			options.nudgeEmptyTurn &&
			!nudgeSent &&
			finishReason === 'stop' &&
			countNonWhitespace(text) === 0 &&
			extractProposal(text) === null
		) {
			nudgeSent = true;
			messages.push({ content: text, role: 'assistant' });
			messages.push({
				content:
					'Your last message was empty. Output the single JSON proposal envelope now.',
				role: 'user',
			});
			continue;
		}

		// S4: substantial-content no-proposal recovery. When the model returns a
		// stop turn with real content (non-empty) but no extractable proposal,
		// send exactly one steering message before declaring failure. This covers
		// the gemma-4 pattern where the model narrates its plan in prose then stops
		// without emitting a JSON envelope. The E4 nudge (above) covers whitespace-
		// only content; this covers the non-empty case.
		//
		// Gate: only fires when ALL of the following hold:
		//   - nudgeEmptyTurn is true (caller expects a JSON proposal)
		//   - the response_format was actually sent to the model (mode != none)
		//   - E4 has not already nudged (exclusive recovery paths)
		//   - no steer has been sent yet (exactly once)
		//   - finish reason is stop (not tool_calls or length)
		//   - content is non-empty (E4 handles the whitespace-only case)
		//   - no proposal is extractable from the content
		//
		// The responseFormatForRequest gate ensures S4 only fires when the model
		// was actually constrained to return structured output. For local models
		// with structuredOutputMode 'none', the format is never sent, prose is
		// a valid response, and S4 must not steer.
		if (
			options.nudgeEmptyTurn &&
			responseFormatForRequest({}, options) !== null &&
			!noProposalSteerSent &&
			!nudgeSent &&
			finishReason === 'stop' &&
			countNonWhitespace(text) > 0 &&
			extractProposal(text) === null
		) {
			noProposalSteerSent = true;
			messages.push({ content: text, role: 'assistant' });
			messages.push({
				content:
					'Your response contained text but no JSON proposal envelope was found. ' +
					'Output the JSON proposal envelope now with the required fields: ' +
					'status, messages, files, patches, scratchpad.',
				role: 'user',
			});
			continue;
		}

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
		return result(
			finishReasons,
			budget,
			responses,
			messages,
			text,
			transportFacts,
		);
	}
}

// Count non-whitespace characters in a string (used for near-empty detection).
function countNonWhitespace(text) {
	if (!text) {
		return 0;
	}
	let count = 0;
	for (const char of text) {
		if (!/\s/u.test(char)) {
			count += 1;
		}
	}
	return count;
}

// Return the content of the last assistant message in the conversation, or ''
// if none exists. Used to salvage the last partial answer on budget exhaustion.
function lastAssistantText(messages) {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (messages[i].role === 'assistant' && messages[i].content) {
			return messages[i].content;
		}
	}
	return '';
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

	registry.register('run_skill_command', {
		description:
			'Run a declared executable helper command from a Markdown skill. Requires explicit approval and an active sandbox executor.',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'Declared skill command name.',
				},
				skill: {
					type: 'string',
					description: 'Skill name or SKILL.md path.',
				},
			},
			required: ['skill', 'command'],
			additionalProperties: false,
		},
		handler: async ({ command, skill }) =>
			runSkillCommand(
				cwd,
				{ command, skill },
				{
					executor: options.skillExecutor || null,
					permissionApprover: options.permissionApprover || null,
					runDir: options.runDir || '',
					timeoutMs: options.timeoutMs,
				},
			),
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

// Normalize outbound tool_calls before they enter conversation history.
// Some models (e.g. devstral-small-2-2512) emit arguments:"" (empty string)
// instead of "{}". Servers such as LM Studio respond HTTP 500 when history
// contains a tool_calls entry with arguments:"". Normalize empty/absent
// arguments to "{}" so the conversation round-trips cleanly.
// This does NOT affect raw-response.json artifacts — those are written from
// chatResponse.body before messages are assembled.
export function normalizeToolCallArguments(toolCalls) {
	if (!Array.isArray(toolCalls)) {
		return toolCalls;
	}
	return toolCalls.map((call) => {
		const args = call?.function?.arguments;
		if (args === '' || args == null) {
			return {
				...call,
				function: { ...call.function, arguments: '{}' },
			};
		}
		return call;
	});
}

function result(
	finishReasons,
	budget,
	responses,
	messages,
	text,
	transportFacts = [],
) {
	return {
		finishReasons,
		loopBudget: budget.snapshot(),
		messages,
		responses,
		text,
		transport: summarizeTransportFacts(transportFacts),
	};
}
