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
			},
			extraHeaders: options.extraHeaders,
			method: 'POST',
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
	);

	return {
		body: {
			choices: [
				{
					finish_reason: content.finishReason || 'stop',
					message: {
						content: content.text,
						role: 'assistant',
					},
				},
			],
			id: content.id || 'chatcmpl_stream',
			object: 'chat.completion',
		},
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

async function readServerSentEvents(response, label) {
	const reader = response.body?.getReader();
	if (!reader) {
		throw new ModelClientError(`${label} returned no stream body`);
	}

	const decoder = new TextDecoder();
	let buffer = '';
	let text = '';
	let finishReason = '';
	let id = '';

	while (true) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
		const events = buffer.split('\n\n');
		buffer = events.pop() || '';

		for (const event of events) {
			const dataLines = event
				.split('\n')
				.filter((line) => line.startsWith('data:'))
				.map((line) => line.slice(5).trim());
			for (const data of dataLines) {
				if (data === '[DONE]') {
					return { finishReason, id, text };
				}

				const parsed = parseJson(data, label);
				if (parsed.id) {
					id = parsed.id;
				}
				const choice = parsed.choices?.[0];
				text += choice?.delta?.content || choice?.message?.content || '';
				if (choice?.finish_reason) {
					finishReason = choice.finish_reason;
				}
			}
		}

		if (done) {
			if (buffer.trim()) {
				const tail = `${buffer}\n\n`;
				buffer = '';
				for (const event of tail.split('\n\n').filter(Boolean)) {
					const data = event
						.split('\n')
						.find((line) => line.startsWith('data:'))
						?.slice(5)
						.trim();
					if (data && data !== '[DONE]') {
						const parsed = parseJson(data, label);
						const choice = parsed.choices?.[0];
						text += choice?.delta?.content || choice?.message?.content || '';
						if (choice?.finish_reason) {
							finishReason = choice.finish_reason;
						}
					}
				}
			}
			return { finishReason, id, text };
		}
	}
}
