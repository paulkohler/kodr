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

export async function listModels(options) {
	return requestJson(`${options.baseUrl}/models`, {
		apiKey: options.apiKey,
		extraHeaders: options.extraHeaders,
		method: 'GET',
		timeoutMs: options.timeoutMs,
	});
}

export async function createChatCompletion(options, body) {
	const requestBody = applyRequestParameters(options, body);
	if (options.stream) {
		return requestStreamJson(`${options.baseUrl}/chat/completions`, {
			apiKey: options.apiKey,
			body: {
				...requestBody,
				stream: true,
				// Ask the server to emit a final usage chunk so streamed runs can
				// still enforce token and cost budgets.
				stream_options: { include_usage: true },
			},
			extraHeaders: options.extraHeaders,
			method: 'POST',
			onStreamContent: options.onStreamContent,
			timeoutMs: options.timeoutMs,
		});
	}

	return requestJson(`${options.baseUrl}/chat/completions`, {
		apiKey: options.apiKey,
		body: requestBody,
		extraHeaders: options.extraHeaders,
		method: 'POST',
		timeoutMs: options.timeoutMs,
	});
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

async function requestStreamJson(url, options) {
	const response = await requestRaw(url, options);
	const content = await readServerSentEvents(
		response,
		`${options.method} ${url}`,
		options.onStreamContent,
	);

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
	const content = body?.choices?.[0]?.message?.content;
	return typeof content === 'string' ? content : '';
}

export function firstFinishReason(body) {
	const finishReason = body?.choices?.[0]?.finish_reason;
	return typeof finishReason === 'string' ? finishReason : '';
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

async function readServerSentEvents(response, label, onStreamContent) {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new ModelClientError(`${label} returned no stream body`);
	}

	const decoder = new TextDecoder();
	const state = {
		finishReason: '',
		id: '',
		text: '',
		// tool_calls arrive as fragments keyed by index; merge them as we go.
		toolCalls: [],
		usage: null,
	};
	let buffer = '';

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

	while (true) {
		let done;
		let value;
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
			return finalizeStreamState(state);
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
