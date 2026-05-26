export class ModelClientError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ModelClientError';
	}
}

export async function listModels(options) {
	return requestJson(`${options.baseUrl}/models`, {
		apiKey: options.apiKey,
		method: 'GET',
		timeoutMs: options.timeoutMs,
	});
}

export async function createChatCompletion(options, body) {
	return requestJson(`${options.baseUrl}/chat/completions`, {
		apiKey: options.apiKey,
		body,
		method: 'POST',
		timeoutMs: options.timeoutMs,
	});
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
	const headers = {
		accept: 'application/json',
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

	const text = await response.text();

	if (!response.ok) {
		throw new ModelClientError(
			`${options.method} ${url} returned HTTP ${response.status}: ${text}`,
		);
	}

	return {
		body: parseJson(text, `${options.method} ${url}`),
		status: response.status,
		url,
	};
}

function parseJson(text, label) {
	try {
		return JSON.parse(text);
	} catch {
		throw new ModelClientError(`${label} returned invalid JSON`);
	}
}
