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

		// stall: the response sends headers (so the client enters SSE reading)
		// but then never sends any data. Used to test the first-token deadline
		// without requiring real clock time.
		if (fakeResponse.stall) {
			recordings.push({
				startedAt,
				durationMs: 0,
				method: request.method,
				url: request.url,
				requestHeaders: redactHeaders(request.headers),
				requestBody,
				responseStatus: 200,
				responseBody: null,
				stalled: true,
			});
			// Send headers so the client receives the HTTP 200 and enters the SSE
			// reader, then hold the connection open without sending any SSE events.
			// flushHeaders() sends the headers immediately without waiting for body.
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.flushHeaders();
			// Keep the socket alive until the client closes it.
			request.socket.on('close', () => {});
			return;
		}

		// Auto-convert JSON chat completion responses to SSE when the client
		// requests streaming (stream: true in the request body). This lets
		// existing tests that provide plain JSON bodies work transparently after
		// the phase-113 always-stream wire change. Tests that already supply a
		// text/event-stream response are served as-is.
		// streamThenStall: send the provided SSE chunk(s), flush, then hold the
		// connection open without sending more — inter-chunk idle deadline test
		// (phase 126): first token arrives, then the stream goes silent mid-read.
		if (fakeResponse.streamThenStall) {
			recordings.push({
				startedAt,
				durationMs: 0,
				method: request.method,
				url: request.url,
				requestHeaders: redactHeaders(request.headers),
				requestBody,
				responseStatus: 200,
				responseBody: null,
				streamThenStalled: true,
			});
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			response.flushHeaders();
			response.write(fakeResponse.streamThenStall);
			request.socket.on('close', () => {});
			return;
		}

		const effectiveResponse = maybeConvertToSse(fakeResponse, requestBody);

		writeFakeResponse(response, effectiveResponse);

		recordings.push({
			startedAt,
			durationMs: Math.round(performance.now() - started),
			method: request.method,
			url: request.url,
			requestHeaders: redactHeaders(request.headers),
			requestBody,
			responseStatus: effectiveResponse.status || 200,
			// Record the original (pre-SSE-conversion) body so test assertions can
			// inspect the structured response regardless of wire format.
			responseBody:
				effectiveResponse.originalBody !== undefined
					? effectiveResponse.originalBody
					: fakeResponse.body,
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

// Convert a plain chat.completion JSON response to SSE format when the
// request body includes stream: true and the queued response does not
// already carry text/event-stream headers. Only chat/completions POST
// bodies are converted; other endpoints (e.g. /models GET) are left alone.
function maybeConvertToSse(fakeResponse, requestBody) {
	// Already streaming content — leave it alone.
	if (
		fakeResponse.headers?.['content-type']?.includes('text/event-stream') ||
		typeof fakeResponse.body === 'string'
	) {
		return fakeResponse;
	}

	// Only auto-convert when the request body asked for streaming.
	if (!requestBody || requestBody.stream !== true) {
		return fakeResponse;
	}

	const body = fakeResponse.body;
	// Only convert objects that look like a chat.completion response.
	if (
		typeof body !== 'object' ||
		body === null ||
		!Array.isArray(body.choices)
	) {
		return fakeResponse;
	}

	// Build SSE events from the choices array.
	const events = [];
	const id = body.id || 'chatcmpl_fake';
	const usage = body.usage || null;

	for (const choice of body.choices) {
		const delta = {};
		const msg = choice.message || {};
		if (msg.content != null) {
			delta.content = msg.content;
		}
		if (Array.isArray(msg.tool_calls)) {
			delta.tool_calls = msg.tool_calls.map((tc, index) => ({
				...tc,
				index,
			}));
		}
		const chunk = {
			id,
			choices: [
				{
					delta,
					finish_reason: choice.finish_reason || null,
				},
			],
			object: 'chat.completion.chunk',
		};
		events.push(`data: ${JSON.stringify(chunk)}`);
	}

	// Append usage chunk if present.
	if (usage) {
		events.push(`data: ${JSON.stringify({ choices: [], usage })}`);
	}

	events.push('data: [DONE]');
	const sseBody = `${events.join('\n\n')}\n\n`;

	return {
		body: sseBody,
		headers: { 'content-type': 'text/event-stream' },
		originalBody: body,
		status: fakeResponse.status || 200,
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
							content: 'kodr-probe-ok',
							role: 'assistant',
						},
						finish_reason: 'stop',
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
	if (entry.stall) {
		return { stall: true };
	}
	if (entry.streamThenStall) {
		return { streamThenStall: entry.streamThenStall };
	}
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
