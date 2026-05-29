export class ModelClientError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ModelClientError';
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
	if (options.stream) {
		return requestStreamJson(`${options.baseUrl}/chat/completions`, {
			apiKey: options.apiKey,
			body: {
				...body,
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
		body,
		extraHeaders: options.extraHeaders,
		method: 'POST',
		timeoutMs: options.timeoutMs,
	});
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
		body: parseJson(text, `${options.method} ${url}`),
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

	let response;
	try {
		response = await fetch(url, {
			body: options.body ? JSON.stringify(options.body) : undefined,
			headers,
			method: options.method,
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (error) {
		throw new ModelClientError(
			`${options.method} ${url} failed: ${error.message}`,
		);
	}

	if (!response.ok) {
		const text = await response.text();
		throw new ModelClientError(
			`${options.method} ${url} returned HTTP ${response.status}: ${text}`,
		);
	}

	return response;
}

function parseJson(text, label) {
	try {
		return JSON.parse(text);
	} catch {
		throw new ModelClientError(`${label} returned invalid JSON`);
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
		const { done, value } = await reader.read();
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
