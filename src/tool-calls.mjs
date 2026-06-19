import { readFile } from 'node:fs/promises';
import { inspectWorkspace, findReferences } from './repomap/index.mjs';
import {
	prepareWrites,
	preparePatches,
	closestRegion,
	countOccurrences,
	normalizePatch,
	jailedPath,
	SafeWriteError,
} from './safe-writes.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
	summarizeTransportFacts,
} from './model-client.mjs';
import { HookBlockedError } from './hooks.mjs';
import { createLoopBudget, LoopBudgetError } from './loop-budgets.mjs';
import { listContextFiles } from './context-packer.mjs';
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

// Default alias map: model-hallucinated or native names → canonical capture tool.
// Evidence: gpt-oss hallucinated write_file every run; devstral calls a native
// `files` tool 4–5 times per run; OpenHands uses str_replace_editor.
export const DEFAULT_TOOL_ALIASES = {
	files: 'write_file',
	create_file: 'write_file',
	str_replace_editor: 'edit_file',
	apply_patch: 'edit_file',
};

export class ToolCallError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ToolCallError';
	}
}

// ProposalDraft accumulates write_file/edit_file calls during the tool loop.
// In proposal mode (default) nothing touches disk — captures are held here until loop end.
// In live mode the handler applies the write immediately and records it here as applied.
// Files: last-wins per path (document order).
// Patches: appended in order (multiple patches to same file allowed).
//
// IMPORTANT: ProposalDraft is a pure data structure with no cwd/fs access.
// Live-apply IO is performed in the tool handlers (where cwd + safe-write helpers are
// available). Handlers call recordFile/recordPatch with {applied:true} after writing.
export class ProposalDraft {
	constructor() {
		// Map<path, {path, content, applied?}> — last-wins per path
		this._files = new Map();
		// Array<{path, search, replace, applied?}> — appended in order
		this._patches = [];
		// alias hits: Map<aliasName, count>
		this._aliasHits = new Map();
	}

	get isEmpty() {
		return this._files.size === 0 && this._patches.length === 0;
	}

	// Record a write_file capture.
	// options.applied=true marks the entry as already written to disk (live mode).
	// options.writeRecord: the write record returned by prepareWrites (live mode only),
	//   carried so buildLiveWriteRecords in app.mjs can populate writes.json with the
	//   real hash and backupPath needed by kodr undo.
	// Returns a terse confirmation string appropriate to the mode.
	// Note: the 'applied' field is only set on the entry when true; absent means
	// not-yet-applied (proposal mode default). This keeps entries backward-
	// compatible with code that does not know about live mode.
	recordFile(path, content, options = {}) {
		const applied = options.applied === true;
		const entry = { path, content };
		if (applied) {
			entry.applied = true;
			if (options.writeRecord) {
				entry.writeRecord = options.writeRecord;
			}
		}
		this._files.set(path, entry);
		const bytes = Buffer.byteLength(content, 'utf8');
		if (applied) {
			return `wrote ${path} (${bytes} bytes)`;
		}
		return `recorded write_file: ${path} (${bytes} bytes) — applies when the task completes`;
	}

	// Record an edit_file capture.
	// options.applied=true marks the entry as already applied to disk (live mode).
	// options.writeRecord: the write record returned by preparePatches (live mode only),
	//   carried so kodr undo can find the real hash and backupPath.
	// Returns a terse confirmation string appropriate to the mode.
	recordPatch(path, search, replace, options = {}) {
		const applied = options.applied === true;
		const entry = { path, search, replace };
		if (applied) {
			entry.applied = true;
			if (options.writeRecord) {
				entry.writeRecord = options.writeRecord;
			}
		}
		this._patches.push(entry);
		if (applied) {
			return `edited ${path}`;
		}
		return `recorded edit_file: ${path} — applies when the task completes`;
	}

	// Record an alias hit.
	recordAlias(alias) {
		this._aliasHits.set(alias, (this._aliasHits.get(alias) ?? 0) + 1);
	}

	// Return captured files array (snapshot). Entries may carry applied:true.
	get files() {
		return Array.from(this._files.values());
	}

	// Return captured patches array (snapshot). Entries may carry applied:true.
	get patches() {
		return [...this._patches];
	}

	// Return alias hits as plain object {aliasName: count}.
	get aliasHits() {
		return Object.fromEntries(this._aliasHits);
	}

	// Return the captured content for a path if recorded by write_file, or null.
	// Used by read_file in proposal mode to return pending content.
	getCapturedContent(path) {
		const entry = this._files.get(path);
		return entry ? entry.content : null;
	}

	// Remove file entries for already-applied paths so read_file goes to disk.
	clearFiles(paths) {
		for (const path of paths) {
			this._files.delete(path);
		}
	}
}

// Holds named tool definitions (schema + handler) and builds the tools array
// for the API request.
export class ToolRegistry {
	constructor(options = {}) {
		this._tools = new Map();
		this.cwd = options.cwd || '';
		this.hooks = options.hooks || null;
		// toolAliases: object mapping alias → canonical tool name.
		this.toolAliases = options.toolAliases || {};
		// proposalDraft: shared draft accumulator for capture tools.
		this.proposalDraft = options.proposalDraft || null;
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
	// W2: alias resolution happens BEFORE the unknown-tool check.
	async dispatch(name, argsJson) {
		// Resolve alias to canonical name if present.
		let resolvedName = name;
		if (!this._tools.has(name) && this.toolAliases[name]) {
			resolvedName = this.toolAliases[name];
			if (this.proposalDraft) {
				this.proposalDraft.recordAlias(name);
			}
		}

		const def = this._tools.get(resolvedName);
		if (!def) {
			const validTools = Array.from(this._tools.keys()).join(', ');
			throw new ToolCallError(
				`Unknown tool: ${name}. Valid tools: ${validTools}. ` +
					'Use write_file or edit_file to propose file changes; the harness applies them after verification.',
			);
		}

		// Security: model-supplied argument strings must be valid JSON objects.
		// A malformed or non-object payload is rejected before the handler runs.
		let args;
		try {
			args = JSON.parse(argsJson || '{}');
		} catch {
			throw new ToolCallError(
				`Invalid JSON arguments for tool "${resolvedName}"`,
			);
		}
		if (args === null || typeof args !== 'object' || Array.isArray(args)) {
			throw new ToolCallError(
				`Tool arguments must be a JSON object for "${resolvedName}"`,
			);
		}

		// W2: if the call came via alias and the argument shape is wrong for the
		// canonical tool, return a steering error naming the canonical schema.
		if (resolvedName !== name) {
			const argShapeError = checkCaptureArgShape(resolvedName, args, name);
			if (argShapeError) {
				throw new ToolCallError(argShapeError);
			}
		}

		let activeArgs = args;
		try {
			const pre = await this.hooks?.run('pre_tool_use', {
				cwd: this.cwd,
				input: activeArgs,
				tool: resolvedName,
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
				tool: resolvedName,
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
	// W3: shared proposal draft from the registry (may be null).
	const proposalDraft = registry?.proposalDraft ?? null;

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
					proposalDraft,
				);
			}
			throw error;
		}

		// F1 final-turn forcing: when exactly one turn remains, send the request
		// without tools so the model must return a final text answer.
		// W3: skip F1 when the capture draft is non-empty — the captured writes
		// already constitute a proposal; forcing a final envelope turn is redundant
		// and may confuse models that have already committed their work via tools.
		const draftNonEmpty = proposalDraft !== null && !proposalDraft.isEmpty;
		const isFinalTurn =
			!draftNonEmpty &&
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
					proposalDraft,
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
					// Track count and escalate after N consecutive repeats.
					const count = seenToolCalls.get(callKey) + 1;
					seenToolCalls.set(callKey, count);
					const ESCALATION_THRESHOLD = 3;
					const staged = options.inStagedPipeline === true;
					content =
						count >= ESCALATION_THRESHOLD
							? JSON.stringify({
									repeat: true,
									count,
									message: staged
										? `You have made this identical tool call ${count} times. ` +
											'Stop retrying. Call write_file for the next file you need to write. ' +
											'Do not run tests or npm install — verification runs automatically after all stages complete.'
										: `You have made this identical tool call ${count} times. ` +
											'Stop retrying. Return your final proposal now — the harness will apply writes and run verification automatically.',
								})
							: JSON.stringify({
									repeat: true,
									count,
									message: staged
										? 'This exact tool call was already made. ' +
											'Call write_file for the next file you need to write. ' +
											'Do not run tests or npm install.'
										: 'This exact tool call was already made. Stop calling tools and return the final JSON proposal now.',
								});
				} else {
					seenToolCalls.set(callKey, 1);
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
			proposalDraft,
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
// options.applyMode: 'proposal' (default) | 'live'
//   proposal — captures write_file/edit_file into draft, applies at run end.
//   live — applies write_file/edit_file to disk immediately via safe-write backup
//           so `kodr undo` works, then records in draft as applied:true.
//   In envelope mode (toolWritesMode:'envelope') the capture tools are omitted and
//   applyMode:live is accepted but inert — writes still come from end-of-run apply.
export function createBuiltinRegistry(cwd, options = {}) {
	const proposalDraft = new ProposalDraft();
	const applyMode = options.applyMode || 'proposal';
	// Tracks accumulated file content per path for per-edit validation in proposal mode.
	// Initialized lazily from disk on first edit_file call; updated after each accepted edit
	// so subsequent calls in the same turn validate against the post-edit state.
	const editAccum = new Map();
	// toolAliases: merge caller-supplied aliases (e.g. from model profile) over defaults.
	const toolAliases = {
		...DEFAULT_TOOL_ALIASES,
		...(options.toolAliases || {}),
	};
	const registry = new ToolRegistry({
		cwd,
		hooks: options.hooks || null,
		proposalDraft,
		toolAliases,
	});

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
		//
		// L3 — proposal-mode read-back: in proposal mode, if the path was captured by
		// write_file, return the captured content with a one-line pending-write note so
		// the model can re-read its own pending writes without them landing on disk.
		// Scope: write_file captures only. edit_file captures (search/replace, no full
		// content) and run_command (discovers files on disk) cannot be satisfied from
		// the draft — live mode is the answer for those. Document this plainly.
		// In live mode disk is the truth (writes already landed); read disk normally.
		handler: async ({ path }) => {
			if (applyMode === 'proposal') {
				const pending = proposalDraft.getCapturedContent(path);
				if (pending !== null) {
					return `[pending write — not yet on disk]\n${pending}`;
				}
			}
			// Live mode or no capture: read from disk.
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
				skillsDirs: options.skillsDirs || [],
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
					skillsDirs: options.skillsDirs || [],
					timeoutMs: options.timeoutMs,
				},
			),
	});

	registry.register('run_command', {
		description:
			'Run an allowlisted verification command in the workspace. Supported commands include npm/pnpm/yarn test, npm run test, node --test [<file>], node --check <file>, pytest, python3 -m unittest [discover], go test ./..., and cargo test.',
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
		handler: async ({ command, timeoutMs }) => {
			// Phase 213: pending-write guard.
			// In proposal mode the model may call run_command to verify files that
			// exist only as pending writes in proposalDraft, not yet on disk.
			// Running the command would fail or hang, burning tool budget.
			// Return a synthetic error+hint so the model returns the final envelope.
			//
			// Phase 215 extension: also intercept bare test-runner commands (e.g.
			// `node --test` with no explicit path) when the draft is non-empty —
			// these slipped through the Phase-213 path check since they contain
			// no path string that matches a pending-write path.
			const TEST_RUNNER_RE =
				/^(node\s+--test|npm\s+(run\s+)?test|yarn\s+test|pnpm\s+test|pytest|python3?\s+-m\s+unittest|go\s+test|cargo\s+test)\b/u;
			if (applyMode === 'proposal' && proposalDraft && !proposalDraft.isEmpty) {
				const pendingPaths = proposalDraft.files.map((f) => f.path);
				if (
					pendingPaths.some((p) => command.includes(p)) ||
					TEST_RUNNER_RE.test(command.trim())
				) {
					return {
						error:
							'Files have not been applied to disk yet — run_command cannot access pending writes.',
						hint: 'Return the final JSON proposal envelope now. The harness will apply your writes and run verification automatically.',
					};
				}
			}
			return runVerification(cwd, command, {
				runner: options.commandRunner || null,
				timeoutMs,
			});
		},
	});

	// W1: capture tools — record proposed file changes without touching disk.
	// T3/T4: envelope mode omits capture tools entirely (pre-117 surface).
	// Path is validated at capture time with the same jail rules as apply.
	// Violations return a steering error result (not a throw) so the model can recover.
	//
	// L2 — live mode: when applyMode === 'live', write_file and edit_file apply to
	// disk immediately through the phase-94 safe-write primitives (prepareWrites /
	// preparePatches) which record backups so `kodr undo` restores prior state.
	// The entries are still recorded in the draft (with applied:true) for the run
	// summary/diff/forensics. The end-of-run apply skips applied entries so nothing
	// is double-written. In envelope mode (toolWritesMode:'envelope') the capture
	// tools are not registered at all; applyMode:live is accepted but inert.
	if (options.toolWritesMode === 'envelope') {
		return registry;
	}

	const liveTimestamp = new Date().toISOString().replaceAll(':', '-');

	registry.register('write_file', {
		description:
			applyMode === 'live'
				? 'Write a complete file immediately to the workspace. The path is jailed and a backup is recorded so `kodr undo` works. For files that already exist on disk, use `edit_file` instead — `write_file` will be rejected if the file exists.'
				: 'Propose writing a complete file. Records the path and content as a proposal entry — nothing is written to disk until the task completes and the harness applies the changes. For files that already exist on disk, use `edit_file` instead — `write_file` will be rejected if the file exists.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Workspace-relative file path to write.',
				},
				content: {
					type: 'string',
					description: 'Complete file content to write.',
				},
			},
			required: ['path', 'content'],
			additionalProperties: false,
		},
		handler: async ({ path, content }) => {
			if (!path || typeof path !== 'string') {
				return JSON.stringify({
					error: 'write_file requires a non-empty string path',
				});
			}
			if (typeof content !== 'string') {
				return JSON.stringify({ error: 'write_file requires string content' });
			}
			try {
				await jailedPath(cwd, path);
			} catch (error) {
				if (error instanceof SafeWriteError) {
					return JSON.stringify({
						error: `Path rejected: ${error.message}. Use a workspace-relative path without .. or absolute segments.`,
					});
				}
				throw error;
			}
			if (applyMode === 'live') {
				// L2: apply to disk immediately using prepareWrites (which backs up first).
				// The backup means `kodr undo` can restore the pre-write state.
				// Capture the write record (hash + backupPath) so kodr undo can find it.
				const liveResult = await prepareWrites(cwd, [{ path, content }], {
					apply: true,
					timestamp: liveTimestamp,
				});
				const writeRecord = liveResult.writes[0] || null;
				return proposalDraft.recordFile(path, content, {
					applied: true,
					writeRecord,
				});
			}
			return proposalDraft.recordFile(path, content);
		},
	});

	registry.register('edit_file', {
		description:
			applyMode === 'live'
				? 'Apply a search-and-replace edit to an existing file immediately. The path is jailed and a backup is recorded so `kodr undo` works.'
				: 'Propose a search-and-replace edit to an existing file. Records the patch as a proposal entry — nothing is written to disk until the task completes and the harness applies the changes.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Workspace-relative file path to edit.',
				},
				search: {
					type: 'string',
					description: 'Exact text to search for in the file.',
				},
				replace: {
					type: 'string',
					description: 'Text to replace the found text with.',
				},
			},
			required: ['path', 'search', 'replace'],
			additionalProperties: false,
		},
		handler: async ({ path, search, replace }) => {
			if (!path || typeof path !== 'string') {
				return JSON.stringify({
					error: 'edit_file requires a non-empty string path',
				});
			}
			if (typeof search !== 'string') {
				return JSON.stringify({ error: 'edit_file requires string search' });
			}
			if (typeof replace !== 'string') {
				return JSON.stringify({ error: 'edit_file requires string replace' });
			}
			try {
				await jailedPath(cwd, path);
			} catch (error) {
				if (error instanceof SafeWriteError) {
					return JSON.stringify({
						error: `Path rejected: ${error.message}. Use a workspace-relative path without .. or absolute segments.`,
					});
				}
				throw error;
			}
			if (applyMode === 'live') {
				// L2: apply the patch to disk immediately using preparePatches (which backs
				// up first). Search-not-found returns the existing patch-failure steering
				// so the model can observe and correct — it is now actionable because the
				// file is real on disk.
				const patchResult = await preparePatches(
					cwd,
					[{ path, search, replace }],
					{ apply: true, timestamp: liveTimestamp },
				);
				if (patchResult.failedPatches.length > 0) {
					const fp = patchResult.failedPatches[0];
					const reasonLabel =
						fp.reason === 'no_match'
							? 'search text not found'
							: fp.reason === 'multiple_matches'
								? `search text matched ${fp.occurrences} times (must match exactly 1)`
								: fp.reason;
					const regionHint = fp.region ? `\nClosest region:\n${fp.region}` : '';
					return JSON.stringify({
						error: `edit_file patch failed: ${reasonLabel}. Recheck your search text against the current file content.${regionHint}`,
					});
				}
				// Capture the write record (hash + backupPath) for kodr undo.
				const writeRecord = patchResult.writes[0] || null;
				return proposalDraft.recordPatch(path, search, replace, {
					applied: true,
					writeRecord,
				});
			}
			// Proposal mode: validate search text against accumulated content so the
			// model gets per-edit feedback within the same tool-call session rather than
			// learning about stale hunks only after the full inner loop ends.
			if (!editAccum.has(path)) {
				const jailed = await jailedPath(cwd, path);
				let diskContent = null;
				try {
					diskContent = await readFile(jailed.absolute, 'utf8');
				} catch {
					// File not found on disk — preparePatches will handle 'missing_target'.
				}
				editAccum.set(path, diskContent);
			}
			const accumulated = editAccum.get(path);
			if (accumulated !== null) {
				const normalized = normalizePatch(accumulated, { search, replace });
				const occurrences = countOccurrences(accumulated, normalized.search);
				if (occurrences !== 1) {
					const reasonLabel =
						occurrences === 0
							? 'search text not found'
							: `search text matched ${occurrences} times (must match exactly 1)`;
					const regionHint =
						occurrences === 0
							? `\nClosest region:\n${closestRegion(accumulated, search)}`
							: '';
					return JSON.stringify({
						error: `edit_file patch failed: ${reasonLabel}. Recheck your search text against the current file content.${regionHint}`,
					});
				}
				editAccum.set(
					path,
					accumulated.replace(normalized.search, normalized.replace),
				);
			}
			return proposalDraft.recordPatch(path, search, replace);
		},
	});

	return registry;
}

// W4: Merge a captured ProposalDraft with an extracted envelope proposal.
// Envelope wins per path for files (model's final word). Patches and messages
// are concatenated (captured first, then envelope). Status/scratchpad from the
// envelope are honored. Provenance metadata added to _extractionMeta.
//
// Returns the merged proposal. If envelopeProposal is null, synthesizes a
// proposal from the draft alone (W3 path). If draft is empty and envelopeProposal
// is non-null, returns the envelope unchanged (regression: existing path).
export function mergeProposalWithDraft(draft, envelopeProposal) {
	const capturedFiles = draft ? draft.files : [];
	const capturedPatches = draft ? draft.patches : [];
	const capturedCount = capturedFiles.length + capturedPatches.length;

	if (!envelopeProposal) {
		// W3 path: synthesize proposal from captured data alone.
		const fileCount = capturedFiles.length;
		const patchCount = capturedPatches.length;
		const totalCount = fileCount + patchCount;
		const synthesized = {
			files: capturedFiles,
			patches: capturedPatches,
			messages: [
				{
					level: 'info',
					content:
						`${fileCount} file${fileCount !== 1 ? 's' : ''} captured via write tools` +
						(patchCount > 0
							? `, ${patchCount} patch${patchCount !== 1 ? 'es' : ''} via edit_file`
							: ''),
				},
			],
			scratchpad: '',
			status: 'OK',
			_extractionMeta: {
				candidateCount: 0,
				proposalCount: 0,
				merged: false,
				channels: { captured: totalCount, envelope: 0, merged: totalCount },
			},
		};
		return synthesized;
	}

	if (capturedCount === 0) {
		// Pure envelope path — return unchanged (regression: existing behavior).
		return envelopeProposal;
	}

	// W4: both draft and envelope present — merge with envelope wins per path.
	const fileMap = new Map();
	// Captured files go in first (lower priority).
	for (const file of capturedFiles) {
		fileMap.set(file.path, file);
	}
	// Envelope files overwrite (higher priority — model's final word).
	for (const file of envelopeProposal.files || []) {
		fileMap.set(file.path, file);
	}

	const mergedFiles = Array.from(fileMap.values());
	const mergedPatches = [
		...capturedPatches,
		...(envelopeProposal.patches || []),
	];
	const mergedCount = mergedFiles.length + mergedPatches.length;
	const envelopeCount =
		(envelopeProposal.files?.length ?? 0) +
		(envelopeProposal.patches?.length ?? 0);

	const prevMeta = envelopeProposal._extractionMeta || {};
	const merged = {
		files: mergedFiles,
		patches: mergedPatches,
		messages: envelopeProposal.messages || [],
		scratchpad: envelopeProposal.scratchpad || '',
		status: envelopeProposal.status || 'OK',
		_extractionMeta: {
			...prevMeta,
			channels: {
				captured: capturedCount,
				envelope: envelopeCount,
				merged: mergedCount,
			},
		},
	};
	return merged;
}

// Resolve the effective proposal from a completion that may have written via the
// tool channel (proposalDraft), the text envelope, or both. Mirrors the
// run-pipeline merge rules (phase 135) so tool-channel writes are never dropped —
// the fix for the orchestration envelope-island bug (phase 152). Returns null
// only when there is neither a non-empty draft nor an envelope proposal.
export function resolveProposalFromCompletion(completion) {
	const draft = completion?.proposalDraft ?? null;
	const draftNonEmpty = draft !== null && !draft.isEmpty;
	const envelopeProposal = extractProposal(completion?.text ?? '');
	if (draftNonEmpty || (draft !== null && envelopeProposal !== null)) {
		return mergeProposalWithDraft(draft, envelopeProposal);
	}
	return envelopeProposal;
}

// W2: Check that an aliased call has the expected argument shape for the
// canonical capture tool. Returns an error string on mismatch, null on ok.
// We validate the required fields for write_file ({path, content}) and
// edit_file ({path, search, replace}). For fully empty args ({}) we also steer
// — the model needs to know what fields to provide.
function checkCaptureArgShape(canonicalName, args, aliasName) {
	if (canonicalName === 'write_file') {
		if (!args.path && !args.content) {
			// Completely empty call (e.g. devstral's `files` with no args) — steer.
			return (
				`Tool "${aliasName}" was called with missing arguments. ` +
				`The canonical tool is write_file, which requires: ` +
				`{"path": "<workspace-relative path>", "content": "<full file content>"}.`
			);
		}
	} else if (canonicalName === 'edit_file') {
		if (!args.path && !args.search && !args.replace) {
			return (
				`Tool "${aliasName}" was called with missing arguments. ` +
				`The canonical tool is edit_file, which requires: ` +
				`{"path": "<path>", "search": "<exact text>", "replace": "<replacement>"}.`
			);
		}
	}
	return null;
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
	proposalDraft = null,
) {
	return {
		finishReasons,
		loopBudget: budget.snapshot(),
		messages,
		proposalDraft,
		responses,
		text,
		transport: summarizeTransportFacts(transportFacts),
	};
}
