import { createServer } from 'node:http';

const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
	}
}

export async function startKodrServer({ channel, cwd, options }) {
	assertLocalHost(options.serveHost);

	const server = createServer((request, response) => {
		void handleHttpRequest(request, response, { channel, cwd, options });
	});
	const closed = new Promise((resolve) => {
		server.on('close', resolve);
	});

	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(options.servePort, options.serveHost);
	});

	const address = server.address();
	const port =
		typeof address === 'object' && address ? address.port : options.servePort;
	const urlHost = options.serveHost === '::1' ? '[::1]' : options.serveHost;

	return {
		closed,
		close: () =>
			new Promise((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
		server,
		url: `http://${urlHost}:${port}`,
	};
}

async function handleHttpRequest(request, response, state) {
	try {
		const url = new URL(
			request.url || '/',
			`http://${request.headers.host || '127.0.0.1'}`,
		);
		const pathname = trimTrailingSlash(url.pathname);

		if (request.method === 'GET' && pathname === '/sessions') {
			const sessions = await state.channel(
				{ kind: 'session-list', options: state.options },
				createServerIo(state.cwd),
			);
			writeJson(response, 200, { sessions });
			return;
		}

		const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/u);
		if (request.method === 'GET' && sessionMatch) {
			const sessionId = decodeURIComponent(sessionMatch[1]);
			const conversation = await state.channel(
				{ kind: 'session-show', options: state.options, sessionId },
				createServerIo(state.cwd),
			);
			writeJson(response, 200, conversation);
			return;
		}

		if (request.method === 'POST' && pathname === '/turn') {
			const body = await readJsonBody(request);
			const turnOptions = createTurnOptions(state.options, body);
			const result = await state.channel(
				{ kind: 'run-turn', options: turnOptions },
				createServerIo(state.cwd),
			);
			writeJson(response, 200, result);
			return;
		}

		writeJson(response, 404, { error: 'Not found' });
	} catch (error) {
		writeJson(response, statusForError(error), {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function assertLocalHost(host) {
	if (!LOCAL_HOSTS.has(host)) {
		throw new HttpError(
			400,
			`kodr serve is local-only; use one of: ${[...LOCAL_HOSTS].join(', ')}`,
		);
	}
}

function createServerIo(cwd) {
	const sink = { write() {} };
	return {
		cwd,
		env: process.env,
		stderr: sink,
		stdout: sink,
	};
}

function createTurnOptions(options, body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new HttpError(400, 'POST /turn requires a JSON object body');
	}
	if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
		throw new HttpError(400, 'POST /turn requires a non-empty prompt string');
	}
	if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
		throw new HttpError(400, 'sessionId must be a string when provided');
	}
	if (body.continue !== undefined && typeof body.continue !== 'boolean') {
		throw new HttpError(400, 'continue must be a boolean when provided');
	}
	if (body.continue && body.sessionId) {
		throw new HttpError(400, 'Use either continue or sessionId, not both');
	}

	const turnOptions = {
		...options,
		command: 'run',
		continueSession: false,
		dryRun: true,
		json: false,
		out: '',
		prompt: body.prompt,
		promptFile: '',
		sessionId: '',
		showContext: false,
		showFiles: false,
		showSkills: false,
		stream: false,
		yes: false,
	};

	if (body.sessionId) {
		turnOptions.sessionId = body.sessionId;
	}
	if (body.continue === true) {
		turnOptions.continueSession = true;
	}
	if (typeof body.model === 'string' && body.model.length > 0) {
		turnOptions.model = body.model;
	}
	if (typeof body.yes === 'boolean') {
		turnOptions.yes = body.yes;
		turnOptions.dryRun = !body.yes;
	}
	if (typeof body.tools === 'boolean') {
		turnOptions.tools = body.tools;
	}

	return turnOptions;
}

async function readJsonBody(request) {
	let body = '';
	for await (const chunk of request) {
		body += chunk;
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
			throw new HttpError(413, 'Request body too large');
		}
	}

	try {
		return body.trim() ? JSON.parse(body) : {};
	} catch {
		throw new HttpError(400, 'Request body must be valid JSON');
	}
}

function statusForError(error) {
	if (error instanceof HttpError) {
		return error.status;
	}
	if (
		error instanceof Error &&
		error.message.startsWith('Session not found:')
	) {
		return 404;
	}
	return 500;
}

function trimTrailingSlash(pathname) {
	if (pathname.length > 1 && pathname.endsWith('/')) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

function writeJson(response, status, payload) {
	const body = JSON.stringify(payload, null, 2);
	response.writeHead(status, {
		'content-length': Buffer.byteLength(body),
		'content-type': 'application/json; charset=utf-8',
	});
	response.end(body);
}
