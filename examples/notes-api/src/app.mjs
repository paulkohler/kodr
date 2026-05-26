import { NoteStore } from './store.mjs';

const MAX_BODY_BYTES = 100_000;

export function createApp(options = {}) {
	const store =
		options.store || new NoteStore(options.notesFile || 'notes.json');

	return async function handle(request, response) {
		try {
			const url = new URL(request.url, 'http://localhost');
			const route = matchRoute(request.method, url.pathname);
			if (!route) {
				return sendJson(response, 404, { error: 'Not found' });
			}

			if (route.name === 'list') {
				return sendJson(response, 200, { notes: await store.list() });
			}

			if (route.name === 'create') {
				const input = validateNoteInput(await readJson(request), {
					partial: false,
				});
				return sendJson(response, 201, { note: await store.create(input) });
			}

			if (route.name === 'read') {
				const note = await store.get(route.id);
				return note
					? sendJson(response, 200, { note })
					: sendJson(response, 404, { error: 'Note not found' });
			}

			if (route.name === 'update') {
				const input = validateNoteInput(await readJson(request), {
					partial: true,
				});
				const note = await store.update(route.id, input);
				return note
					? sendJson(response, 200, { note })
					: sendJson(response, 404, { error: 'Note not found' });
			}

			if (route.name === 'delete') {
				const note = await store.delete(route.id);
				return note
					? sendJson(response, 200, { note })
					: sendJson(response, 404, { error: 'Note not found' });
			}
		} catch (error) {
			return sendJson(response, error.statusCode || 500, {
				error: error.statusCode ? error.message : 'Internal server error',
			});
		}
	};
}

function matchRoute(method, pathname) {
	if (method === 'GET' && pathname === '/notes') {
		return { name: 'list' };
	}
	if (method === 'POST' && pathname === '/notes') {
		return { name: 'create' };
	}

	const match = /^\/notes\/([^/]+)$/u.exec(pathname);
	if (!match) {
		return null;
	}

	const id = decodeURIComponent(match[1]);
	if (method === 'GET') {
		return { id, name: 'read' };
	}
	if (method === 'PATCH') {
		return { id, name: 'update' };
	}
	if (method === 'DELETE') {
		return { id, name: 'delete' };
	}

	return null;
}

async function readJson(request) {
	const text = await readBody(request);
	if (!text) {
		throw httpError(400, 'JSON body is required');
	}

	try {
		return JSON.parse(text);
	} catch {
		throw httpError(400, 'Invalid JSON body');
	}
}

function validateNoteInput(input, options) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw httpError(400, 'JSON body must be an object');
	}

	const output = {};
	if (Object.hasOwn(input, 'title')) {
		if (typeof input.title !== 'string' || input.title.trim() === '') {
			throw httpError(400, 'title must be a non-empty string');
		}
		output.title = input.title.trim();
	}
	if (Object.hasOwn(input, 'body')) {
		if (typeof input.body !== 'string') {
			throw httpError(400, 'body must be a string');
		}
		output.body = input.body;
	}

	if (!options.partial && (!output.title || !Object.hasOwn(output, 'body'))) {
		throw httpError(400, 'title and body are required');
	}
	if (options.partial && Object.keys(output).length === 0) {
		throw httpError(400, 'At least one note field is required');
	}

	return output;
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		let body = '';
		request.setEncoding('utf8');
		request.on('data', (chunk) => {
			body += chunk;
			if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
				reject(httpError(413, 'Request body is too large'));
				request.destroy();
			}
		});
		request.on('end', () => resolve(body));
		request.on('error', reject);
	});
}

function sendJson(response, statusCode, body) {
	response.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
	});
	response.end(`${JSON.stringify(body)}\n`);
}

function httpError(statusCode, message) {
	const error = new Error(message);
	error.statusCode = statusCode;
	return error;
}
