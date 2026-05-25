import { createServer } from 'node:http';

const DEFAULT_MODEL_ID = 'fake-local-model';

export async function startFakeModelServer(options = {}) {
	const recordings = [];
	const responseQueue = [...(options.responses || [])];
	const modelId = options.modelId || DEFAULT_MODEL_ID;

	const server = createServer(async (request, response) => {
		const startedAt = new Date().toISOString();
		const started = performance.now();
		const requestBodyText = await readRequestBody(request);
		const requestBody = parseMaybeJson(requestBodyText);
		const queuedResponse = takeQueuedResponse(responseQueue, request);
		const fakeResponse =
			queuedResponse || defaultResponse(request.method, request.url, modelId);

		writeFakeResponse(response, fakeResponse);

		recordings.push({
			startedAt,
			durationMs: Math.round(performance.now() - started),
			method: request.method,
			url: request.url,
			requestHeaders: redactHeaders(request.headers),
			requestBody,
			responseStatus: fakeResponse.status || 200,
			responseBody: fakeResponse.body,
		});
	});

	await listen(server);

	return {
		baseUrl: serverBaseUrl(server),
		close() {
			return close(server);
		},
		recordings,
	};
}

function defaultResponse(method, url, modelId) {
	if (method === 'GET' && url === '/v1/models') {
		return {
			body: {
				data: [
					{
						id: modelId,
						object: 'model',
					},
				],
				object: 'list',
			},
			status: 200,
		};
	}

	if (method === 'POST' && url === '/v1/chat/completions') {
		return {
			body: {
				choices: [
					{
						message: {
							content: 'koder-probe-ok',
							role: 'assistant',
						},
					},
				],
				id: 'chatcmpl_fake',
				object: 'chat.completion',
			},
			status: 200,
		};
	}

	return {
		body: {
			error: 'not found',
		},
		status: 404,
	};
}

function takeQueuedResponse(responseQueue, request) {
	const index = responseQueue.findIndex((entry) => {
		const methodMatches = !entry.method || entry.method === request.method;
		const urlMatches = !entry.url || entry.url === request.url;
		return methodMatches && urlMatches;
	});

	if (index === -1) {
		return null;
	}

	const [entry] = responseQueue.splice(index, 1);
	return {
		body: entry.body,
		headers: entry.headers,
		status: entry.status,
	};
}

function writeFakeResponse(response, fakeResponse) {
	const status = fakeResponse.status || 200;
	const headers = {
		'content-type': 'application/json',
		...(fakeResponse.headers || {}),
	};

	response.writeHead(status, headers);

	if (typeof fakeResponse.body === 'string') {
		response.end(fakeResponse.body);
		return;
	}

	response.end(JSON.stringify(fakeResponse.body));
}

function redactHeaders(headers) {
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => [
			key,
			key.toLowerCase() === 'authorization' ? '[redacted]' : value,
		]),
	);
}

function parseMaybeJson(text) {
	if (!text) {
		return '';
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
}

function close(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function serverBaseUrl(server) {
	const address = server.address();
	return `http://${address.address}:${address.port}/v1`;
}

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		let body = '';

		request.setEncoding('utf8');
		request.on('data', (chunk) => {
			body += chunk;
		});
		request.on('end', () => {
			resolve(body);
		});
		request.on('error', reject);
	});
}
