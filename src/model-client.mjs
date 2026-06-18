import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

export class ModelClientError extends Error {
	constructor(message, details = {}) {
		super(message, details.cause ? { cause: details.cause } : undefined);
		this.name = 'ModelClientError';
		this.details = sanitizeErrorDetails(details);
	}
}

// Thrown when no SSE data arrives within firstTokenTimeoutMs. Callers may
// catch this specifically to retry exactly once (T3).
export class FirstTokenTimeoutError extends Error {
	constructor(timeoutMs) {
		const secs = Math.round(timeoutMs / 1000);
		super(
			`no first token after ${secs}s (server stalled?) — ` +
				`retry will follow; use --first-token-timeout-ms to adjust`,
		);
		this.name = 'FirstTokenTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

// Default first-token deadline. Overridden via model profile or CLI flag.
export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 120000;

// Thrown when a stream that already started goes silent mid-read for longer than
// idleTimeoutMs (phase 126). Distinct from FirstTokenTimeoutError: the first
// token already arrived, so this is not retried — it fails the turn fast with a
// clear signal instead of hanging until the overall request timeout.
export class InterChunkIdleTimeoutError extends Error {
	constructor(timeoutMs) {
		const secs = Math.round(timeoutMs / 1000);
		super(
			`stream went silent for ${secs}s after the first token (server stalled mid-response?) — ` +
				'use --idle-timeout-ms to adjust',
		);
		this.name = 'InterChunkIdleTimeoutError';
		this.timeoutMs = timeoutMs;
	}
}

// Default inter-chunk idle deadline. Once streaming has begun, no SSE data for
// this long fails the turn. Overridden via model profile or CLI flag.
export const DEFAULT_IDLE_TIMEOUT_MS = 120000;

// Aggregate per-turn transport facts into a run-level summary.
// facts: Array<{ wire, timeToFirstTokenMs, firstTokenRetries }>
export function summarizeTransportFacts(facts) {
	if (!Array.isArray(facts) || facts.length === 0) {
		return null;
	}
	const ttfts = facts.map((f) => f.timeToFirstTokenMs).filter((v) => v != null);
	const retries = facts.reduce((sum, f) => sum + (f.firstTokenRetries || 0), 0);
	return {
		firstTokenRetries: retries,
		timeToFirstTokenMs: ttfts.length > 0 ? ttfts : null,
		wire: facts[0]?.wire || 'unknown',
	};
}

export async function listModels(options) {
	return requestJson(`${options.baseUrl}/models`, {
		apiKey: options.apiKey,
		extraHeaders: options.extraHeaders,
		method: 'GET',
		timeoutMs: options.timeoutMs,
	});
}

// createChatCompletion always uses the SSE streaming wire format so the
// request returns a first token quickly (LM Studio non-streaming hangs).
// options.stream / options.wireNoStream control:
//   - options.wireNoStream === true  → non-streaming wire (escape hatch for
//     debugging servers that can't stream; never chosen automatically)
//   - options.stream (true/false/'auto') → display rendering only; does not
//     affect the wire protocol
// Returns { body, status, url, transport } where transport carries TTFT facts.
export async function createChatCompletion(options, body) {
	const requestBody = buildChatRequestBody(options, body);

	// Non-streaming wire: set via --wire-no-stream flag or profile.wireNoStream.
	// Required for thinking models (e.g. qwen3.6) where LM Studio ignores
	// max_thinking_tokens in streaming mode.
	if (options.wireNoStream) {
		return requestJson(`${options.baseUrl}/chat/completions`, {
			apiKey: options.apiKey,
			body: requestBody,
			extraHeaders: options.extraHeaders,
			method: 'POST',
			timeoutMs: options.timeoutMs,
		});
	}

	const firstTokenTimeoutMs =
		options.firstTokenTimeoutMs != null && options.firstTokenTimeoutMs !== ''
			? Number(options.firstTokenTimeoutMs)
			: DEFAULT_FIRST_TOKEN_TIMEOUT_MS;

	const idleTimeoutMs =
		options.idleTimeoutMs != null && options.idleTimeoutMs !== ''
			? Number(options.idleTimeoutMs)
			: DEFAULT_IDLE_TIMEOUT_MS;

	const url = `${options.baseUrl}/chat/completions`;
	const streamOpts = {
		apiKey: options.apiKey,
		body: {
			...requestBody,
			stream: true,
			// Ask the server to emit a final usage chunk so streamed runs can
			// still enforce token and cost budgets.
			stream_options: { include_usage: true },
		},
		extraHeaders: options.extraHeaders,
		firstTokenTimeoutMs,
		idleTimeoutMs,
		method: 'POST',
		onStreamContent: options.onStreamContent,
		onToken: options.onToken,
		timeoutMs: options.timeoutMs,
	};

	let result;
	try {
		result = await requestStreamJson(url, streamOpts);
	} catch (error) {
		if (error instanceof FirstTokenTimeoutError) {
			// T3: exactly one automatic retry on first-token timeout.
			if (options.onFirstTokenRetry) {
				options.onFirstTokenRetry(error);
			}
			const retryResult = await requestStreamJson(url, streamOpts);
			return {
				...retryResult,
				transport: {
					...(retryResult.transport || {}),
					firstTokenRetries: 1,
				},
			};
		}
		throw error;
	}

	return result;
}

export function buildChatRequestBody(options, body) {
	return applyPromptCacheControl(
		options,
		applyRequestParameters(options, body),
	);
}

function applyRequestParameters(options, body) {
	if (
		options.maxThinkingTokens === '' ||
		options.maxThinkingTokens === undefined ||
		Object.hasOwn(body, 'max_thinking_tokens')
	) {
		return body;
	}
	return {
		...body,
		max_thinking_tokens: options.maxThinkingTokens,
	};
}

function applyPromptCacheControl(options, body) {
	if (
		options.promptCache === 'off' ||
		Object.hasOwn(body, 'cache_control') ||
		!shouldUseAnthropicRootCacheControl(options, body.model)
	) {
		return body;
	}
	return {
		...body,
		cache_control: { type: 'ephemeral' },
	};
}

export function shouldUseAnthropicRootCacheControl(options, model) {
	if (!isAnthropicModel(model)) {
		return false;
	}
	return !isLocalCostFreeModel(options, model);
}

export function isAnthropicModel(model) {
	return typeof model === 'string' && model.includes('anthropic/');
}

export function isOllamaCloudModel(model) {
	return typeof model === 'string' && model.endsWith(':cloud');
}

export function isLocalCostFreeModel(options = {}, model = '') {
	const provider = options.provider || '';
	if (provider === 'ollama' && isOllamaCloudModel(model)) {
		return false;
	}
	return (
		provider === 'local' ||
		provider === 'lmstudio' ||
		provider === 'ollama' ||
		!provider
	);
}

async function requestStreamJson(url, options) {
	const response = await requestRaw(url, options);
	const startedAt = Date.now();
	const content = await readServerSentEvents(
		response,
		`${options.method} ${url}`,
		options.onStreamContent,
		options.firstTokenTimeoutMs,
		options.idleTimeoutMs,
		options.onToken,
	);

	const timeToFirstTokenMs = content.timeToFirstTokenMs;

	const message = {
		content: content.text,
		role: 'assistant',
	};
	if (content.toolCalls.length > 0) {
		message.tool_calls = content.toolCalls;
	}

	const finishReason =
		content.finishReason ||
		(content.toolCalls.length > 0 ? 'tool_calls' : 'stop');

	const body = {
		choices: [
			{
				finish_reason: finishReason,
				message,
			},
		],
		id: content.id || 'chatcmpl_stream',
		object: 'chat.completion',
	};
	if (content.usage) {
		body.usage = content.usage;
	}

	return {
		body,
		status: response.status,
		transport: {
			firstTokenRetries: 0,
			timeToFirstTokenMs: timeToFirstTokenMs ?? null,
			wire: 'stream',
		},
		url,
	};
}

export function firstModelId(body) {
	if (!body || !Array.isArray(body.data)) {
		return '';
	}

	const model = body.data.find((item) => {
		return item && typeof item.id === 'string' && item.id.length > 0;
	});
	return model ? model.id : '';
}

export function firstAssistantMessage(body) {
	const message = body?.choices?.[0]?.message;
	const content = message?.content;
	if (typeof content === 'string' && content.length > 0) {
		return stripModelControlTokens(content);
	}
	const reasoningContent = message?.reasoning_content;
	if (typeof reasoningContent === 'string' && looksLikeJson(reasoningContent)) {
		return reasoningContent;
	}
	return typeof content === 'string' ? content : '';
}

// Some models (e.g. openai/gpt-oss-20b) emit internal structured-output control
// tokens as literal text before the response body, e.g.:
//   <|channel|>final <|constrain|>json<|message|>```json{...}```
// Strip any leading <|token|>interstitial_text blocks so JSON extraction works.
function stripModelControlTokens(text) {
	if (!text.startsWith('<|')) {
		return text;
	}
	return text.replace(/^(<\|[^|>]+\|>[^<`[{]*)+/u, '').trimStart();
}

export function firstFinishReason(body) {
	const finishReason = body?.choices?.[0]?.finish_reason;
	return typeof finishReason === 'string' ? finishReason : '';
}

function looksLikeJson(value) {
	const trimmed = value.trim();
	return trimmed.startsWith('{') || trimmed.startsWith('[');
}

async function requestJson(url, options) {
	const response = await requestRaw(url, options);
	const text = await response.text();

	return {
		body: parseJson(text, `${options.method} ${url}`, {
			phase: 'parse-json',
			responseTextBytes: Buffer.byteLength(text),
			responseTextSample: sampleText(text),
			status: response.status,
			url,
		}),
		status: response.status,
		transport: { firstTokenRetries: 0, timeToFirstTokenMs: null, wire: 'none' },
		url,
	};
}

async function requestRaw(url, options) {
	const headers = {
		accept: 'application/json',
		...(options.extraHeaders || {}),
	};

	if (options.body) {
		headers['content-type'] = 'application/json';
	}

	if (options.apiKey) {
		headers.authorization = `Bearer ${options.apiKey}`;
	}

	const bodyText = options.body ? JSON.stringify(options.body) : undefined;
	// Set Content-Length so Node.js sends as a single body rather than using
	// chunked transfer encoding. LM Studio's HTTP server misparses chunked
	// bodies when a multi-byte UTF-8 sequence crosses a chunk boundary.
	if (bodyText) {
		headers['content-length'] = Buffer.byteLength(bodyText);
	}
	const startedAt = Date.now();
	let response;
	try {
		response = await requestWithNodeHttp(url, {
			bodyText,
			headers,
			method: options.method,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		throw new ModelClientError(
			`${options.method} ${url} failed: ${error.message}`,
			{
				cause: error,
				elapsedMs: Date.now() - startedAt,
				method: options.method,
				phase: 'fetch',
				requestBodyBytes: bodyText ? Buffer.byteLength(bodyText) : 0,
				timeoutMs: options.timeoutMs,
				url,
			},
		);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new ModelClientError(
			`${options.method} ${url} returned HTTP ${response.status}: ${text}`,
			{
				elapsedMs: Date.now() - startedAt,
				method: options.method,
				phase: 'http-response',
				requestBodyBytes: bodyText ? Buffer.byteLength(bodyText) : 0,
				responseTextBytes: Buffer.byteLength(text),
				responseTextSample: sampleText(text),
				status: response.status,
				timeoutMs: options.timeoutMs,
				url,
			},
		);
	}

	return response;
}

function requestWithNodeHttp(url, options) {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
		let settled = false;
		let response = null;
		let timeoutId = null;

		const fail = (error) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
				return;
			}
			response?.destroy(error);
		};

		const request = transport(
			{
				headers: options.headers,
				hostname: parsed.hostname,
				method: options.method,
				path: `${parsed.pathname}${parsed.search}`,
				port: parsed.port || undefined,
				protocol: parsed.protocol,
			},
			(incoming) => {
				response = incoming;
				incoming.on('end', () => clearTimeout(timeoutId));
				incoming.on('close', () => clearTimeout(timeoutId));
				settled = true;
				resolve(toModelResponse(incoming));
			},
		);

		timeoutId = setTimeout(() => {
			const error = new Error(`request timed out after ${options.timeoutMs}ms`);
			error.name = 'TimeoutError';
			error.code = 'KODR_REQUEST_TIMEOUT';
			request.destroy(error);
			fail(error);
		}, options.timeoutMs);
		timeoutId.unref?.();

		request.on('error', fail);
		request.on('close', () => {
			if (!settled) {
				clearTimeout(timeoutId);
			}
		});

		if (options.bodyText) {
			request.write(options.bodyText);
		}
		request.end();
	});
}

function toModelResponse(incoming) {
	return {
		get body() {
			return Readable.toWeb(incoming);
		},
		ok: incoming.statusCode >= 200 && incoming.statusCode < 300,
		status: incoming.statusCode,
		text() {
			return readIncomingText(incoming);
		},
	};
}

function readIncomingText(incoming) {
	return new Promise((resolve, reject) => {
		incoming.setEncoding('utf8');
		let text = '';
		incoming.on('data', (chunk) => {
			text += chunk;
		});
		incoming.on('end', () => {
			resolve(text);
		});
		incoming.on('error', reject);
	});
}

function parseJson(text, label, details = {}) {
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ModelClientError(`${label} returned invalid JSON`, {
			cause: error,
			...details,
		});
	}
}

// readServerSentEvents reads an SSE response stream, optionally applying a
// first-token deadline. If firstTokenTimeoutMs is set and no data chunk
// arrives within that time, throws FirstTokenTimeoutError.
async function readServerSentEvents(
	response,
	label,
	onStreamContent,
	firstTokenTimeoutMs,
	idleTimeoutMs,
	onToken,
) {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new ModelClientError(`${label} returned no stream body`);
	}

	const decoder = new TextDecoder();
	const state = {
		finishReason: '',
		id: '',
		onToken,
		text: '',
		// tool_calls arrive as fragments keyed by index; merge them as we go.
		toolCalls: [],
		usage: null,
	};
	let buffer = '';
	let firstTokenMs = null; // ms since readServerSentEvents was called
	const readStart = Date.now();
	let firstChunkSeen = false;

	const consume = (event) => {
		const dataLines = event
			.split('\n')
			.filter((line) => line.startsWith('data:'))
			.map((line) => line.slice(5).trim());
		for (const data of dataLines) {
			if (!data || data === '[DONE]') {
				continue;
			}
			applyStreamEvent(state, parseJson(data, label), onStreamContent);
		}
	};

	// Deadline tracking: before the first byte, a fixed first-token deadline
	// applies (T3, phase 113). After the first byte, a rolling inter-chunk idle
	// deadline applies (phase 126) — measured from the previous read's return, so
	// a stream that goes silent mid-response fails fast with a distinct error
	// instead of hanging until the overall request timeout. We only treat the
	// first-token deadline as satisfied when a chunk with actual bytes arrives;
	// zero-byte reads (header-flush side effects on some Node.js versions) must
	// not suppress it.
	const firstTokenDeadlineMs =
		firstTokenTimeoutMs != null ? Date.now() + firstTokenTimeoutMs : null;

	while (true) {
		// Choose the active deadline + error for this read.
		const beforeFirst = !firstChunkSeen;
		const deadlineMs = beforeFirst
			? firstTokenDeadlineMs
			: idleTimeoutMs != null
				? Date.now() + idleTimeoutMs
				: null;
		const makeTimeoutError = beforeFirst
			? () => new FirstTokenTimeoutError(firstTokenTimeoutMs)
			: () => new InterChunkIdleTimeoutError(idleTimeoutMs);

		let done;
		let value;
		if (deadlineMs !== null) {
			const remaining = deadlineMs - Date.now();
			if (remaining <= 0) {
				reader.cancel().catch(() => {});
				throw makeTimeoutError();
			}
			let timeoutId;
			const timeoutPromise = new Promise((_resolve, reject) => {
				timeoutId = setTimeout(() => reject(makeTimeoutError()), remaining);
				// Do not unref this timer — it must fire even if I/O is the only
				// other pending work (test environments with a stalled server).
			});
			let chunk;
			try {
				chunk = await Promise.race([reader.read(), timeoutPromise]);
			} catch (error) {
				if (
					error instanceof FirstTokenTimeoutError ||
					error instanceof InterChunkIdleTimeoutError
				) {
					reader.cancel().catch(() => {});
					throw error;
				}
				throw new ModelClientError(
					`${label} stream read failed: ${error.message}`,
					{
						cause: error,
						phase: 'stream-read',
						status: response.status,
					},
				);
			} finally {
				clearTimeout(timeoutId);
			}
			done = chunk.done;
			value = chunk.value;
		} else {
			try {
				({ done, value } = await reader.read());
			} catch (error) {
				throw new ModelClientError(
					`${label} stream read failed: ${error.message}`,
					{
						cause: error,
						phase: 'stream-read',
						status: response.status,
					},
				);
			}
		}

		// Only count non-empty chunks as "first token" — empty reads can occur
		// as a side-effect of header flushing and must not suppress the deadline.
		if (!firstChunkSeen && (done || (value && value.length > 0))) {
			firstChunkSeen = true;
			firstTokenMs = Date.now() - readStart;
		}

		buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
		const events = buffer.split('\n\n');
		buffer = events.pop() || '';

		for (const event of events) {
			consume(event);
		}

		if (done) {
			if (buffer.trim()) {
				consume(buffer);
			}
			return {
				...finalizeStreamState(state),
				timeToFirstTokenMs: firstTokenMs,
			};
		}
	}
}

function sanitizeErrorDetails(details) {
	const sanitized = {};
	for (const [key, value] of Object.entries(details)) {
		if (key === 'cause') {
			const cause = serializeCause(value);
			if (cause) {
				sanitized.cause = cause;
			}
			continue;
		}
		if (value !== undefined) {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

function serializeCause(error) {
	if (!error || typeof error !== 'object') {
		return null;
	}
	const cause = {
		message: typeof error.message === 'string' ? error.message : '',
		name: typeof error.name === 'string' ? error.name : '',
	};
	if (typeof error.code === 'string') {
		cause.code = error.code;
	}
	if (error.cause && typeof error.cause === 'object') {
		cause.cause = serializeCause(error.cause);
	}
	return cause;
}

function sampleText(text) {
	return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

function applyStreamEvent(state, parsed, onStreamContent) {
	if (parsed.id) {
		state.id = parsed.id;
	}
	if (parsed.usage) {
		state.usage = parsed.usage;
	}

	const choice = parsed.choices?.[0];
	if (!choice) {
		return;
	}

	const content = choice.delta?.content || choice.message?.content || '';
	state.text += content;
	if (content && onStreamContent) {
		onStreamContent(content);
	}
	if (content && state.onToken) {
		try {
			state.onToken(content);
		} catch {
			// Ignore: a throwing onToken must not break the read loop.
		}
	}
	if (choice.finish_reason) {
		state.finishReason = choice.finish_reason;
	}

	const toolCalls = choice.delta?.tool_calls || choice.message?.tool_calls;
	if (Array.isArray(toolCalls)) {
		for (const fragment of toolCalls) {
			mergeToolCallFragment(state.toolCalls, fragment);
		}
	}
}

// Tool calls stream as partial fragments: the first carries id/name, later ones
// append to function.arguments. Fragments are addressed by `index`.
function mergeToolCallFragment(toolCalls, fragment) {
	const index = typeof fragment.index === 'number' ? fragment.index : 0;
	let call = toolCalls[index];
	if (!call) {
		call = { id: '', type: 'function', function: { name: '', arguments: '' } };
		toolCalls[index] = call;
	}

	if (fragment.id) {
		call.id = fragment.id;
	}
	if (fragment.type) {
		call.type = fragment.type;
	}
	if (fragment.function?.name) {
		call.function.name = fragment.function.name;
	}
	if (fragment.function?.arguments) {
		call.function.arguments += fragment.function.arguments;
	}
}

function finalizeStreamState(state) {
	return {
		finishReason: state.finishReason,
		id: state.id,
		text: state.text,
		toolCalls: state.toolCalls.filter(Boolean),
		usage: state.usage,
	};
}
