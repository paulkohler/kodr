import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';
import {
	createRunRegistry,
	isFinalStatus,
	phaseForProgressEvent,
	publicRun,
} from './run-registry.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const RUN_BODY_FIELDS = new Set([
	'continue',
	'install',
	'model',
	'prompt',
	'sessionId',
	'subagentStages',
	'test',
	'tools',
	'yes',
]);

const ARTIFACT_ALLOWLIST = new Set([
	'context.md',
	'conversation-raw.json',
	'conversation.json',
	'docker.json',
	'eval-results.json',
	'hooks.json',
	'install.json',
	'messages.json',
	'openshell.json',
	'orchestration.json',
	'prompt-prefix.json',
	'prompt.md',
	'raw-request.json',
	'raw-response.json',
	'response.md',
	'scratchpad.md',
	'session-summary.json',
	'summary.json',
	'tasks.json',
	'tests.json',
	'writes.json',
]);

const ARTIFACT_CONTENT_TYPES = new Map([
	['.json', 'application/json; charset=utf-8'],
	['.md', 'text/markdown; charset=utf-8'],
]);

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
	}
}

export async function startKodrServer({ channel, cwd, options }) {
	assertLocalHost(options.serveHost);

	const state = {
		channel,
		cwd,
		options,
		pendingTurnOptions: new Map(),
		registry: createRunRegistry({
			maxActiveRuns: options.serveMaxActiveRuns || 1,
		}),
		runDirs: new Map(),
		startedAt: new Date().toISOString(),
	};

	const server = createServer((request, response) => {
		void handleHttpRequest(request, response, state);
	});
	const closed = new Promise((resolve) => {
		server.on('close', resolve);
	});

	await new Promise((resolvePromise, reject) => {
		const onError = (error) => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			resolvePromise();
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
			new Promise((resolvePromise, reject) => {
				server.close((error) => (error ? reject(error) : resolvePromise()));
			}),
		registry: state.registry,
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

		if (request.method === 'GET' && pathname === '/health') {
			writeJson(response, 200, { ok: true, status: 'ok' });
			return;
		}

		if (request.method === 'GET' && pathname === '/status') {
			writeJson(response, 200, {
				activeRuns: state.registry.activeCount(),
				maxActiveRuns: state.registry.maxActiveRuns,
				ok: true,
				queuedRuns: state.registry.queuedRuns().length,
				runCount: state.registry.list().length,
				startedAt: state.startedAt,
			});
			return;
		}

		if (request.method === 'POST' && pathname === '/runs') {
			const body = await readJsonBody(request);
			const record = submitRun(state, body, {});
			writeJson(response, 202, runSubmissionResponse(state, record));
			return;
		}

		if (request.method === 'GET' && pathname === '/runs') {
			writeJson(response, 200, { runs: state.registry.list() });
			return;
		}

		const runMatch = pathname.match(/^\/runs\/([^/]+)(?:\/([^/]+))?$/u);
		if (runMatch) {
			const runId = decodeURIComponent(runMatch[1]);
			const subRoute = runMatch[2] ? decodeURIComponent(runMatch[2]) : '';
			const run = state.registry.get(runId);
			if (!run) {
				writeJson(response, 404, { error: `Unknown run: ${runId}` });
				return;
			}

			if (request.method === 'GET' && !subRoute) {
				writeJson(response, 200, publicRun(run));
				return;
			}
			if (request.method === 'GET' && subRoute === 'events') {
				handleRunEvents(request, response, state, runId);
				return;
			}
			if (request.method === 'GET' && subRoute === 'logs') {
				writeJson(response, 200, {
					logs: state.registry.eventsSince(runId, 0),
					runId,
				});
				return;
			}
			if (request.method === 'GET' && subRoute === 'artifacts') {
				writeJson(response, 200, await listRunArtifacts(state, runId));
				return;
			}
			if (request.method === 'POST' && subRoute === 'cancel') {
				writeJson(response, 200, cancelRun(state, runId));
				return;
			}
		}

		const artifactMatch = pathname.match(
			/^\/runs\/([^/]+)\/artifacts\/([^/]+)$/u,
		);
		if (request.method === 'GET' && artifactMatch) {
			const runId = decodeURIComponent(artifactMatch[1]);
			const name = decodeURIComponent(artifactMatch[2]);
			await serveRunArtifact(response, state, runId, name);
			return;
		}

		if (request.method === 'GET' && pathname === '/sessions') {
			const sessions = await state.channel(
				{ kind: 'session-list', options: state.options },
				createServerIo(state.cwd),
			);
			writeJson(response, 200, { sessions });
			return;
		}

		const sessionTurnMatch = pathname.match(/^\/sessions\/([^/]+)\/turns$/u);
		if (request.method === 'POST' && sessionTurnMatch) {
			const sessionId = decodeURIComponent(sessionTurnMatch[1]);
			const body = await readJsonBody(request);
			if (body && typeof body === 'object') {
				if (body.sessionId !== undefined) {
					throw new HttpError(
						400,
						'POST /sessions/:id/turns takes the session from the URL; do not pass sessionId',
					);
				}
				if (body.continue !== undefined) {
					throw new HttpError(
						400,
						'POST /sessions/:id/turns continues the URL session; do not pass continue',
					);
				}
			}
			const record = submitRun(state, body, { sessionId });
			writeJson(response, 202, runSubmissionResponse(state, record));
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
			const turnOptions = createTurnOptions(state.options, body, '/turn');
			const result = await state.channel(
				{ kind: 'run-turn', options: turnOptions },
				createServerIo(state.cwd),
			);
			writeJson(response, 200, result);
			return;
		}

		writeJson(response, 404, { error: 'Not found' });
	} catch (error) {
		if (!response.headersSent) {
			writeJson(response, statusForError(error), {
				error: error instanceof Error ? error.message : String(error),
			});
		} else {
			response.end();
		}
	}
}

function submitRun(state, body, { sessionId = '' }) {
	const turnOptions = createRunTurnOptions(state.options, body, sessionId);
	const record = state.registry.submit({
		model: turnOptions.model || '',
		prompt: turnOptions.prompt,
		sessionId: turnOptions.sessionId,
	});
	state.pendingTurnOptions.set(record.runId, turnOptions);
	startQueuedRuns(state);
	return record;
}

function runSubmissionResponse(state, record) {
	const run = state.registry.get(record.runId);
	return {
		eventsUrl: `/runs/${encodeURIComponent(run.runId)}/events`,
		runId: run.runId,
		sessionId: run.sessionId,
		status: run.status,
		statusUrl: `/runs/${encodeURIComponent(run.runId)}`,
	};
}

function startQueuedRuns(state) {
	while (state.registry.canStart()) {
		const next = state.registry.queuedRuns()[0];
		if (!next) {
			return;
		}
		const turnOptions = state.pendingTurnOptions.get(next.runId);
		state.pendingTurnOptions.delete(next.runId);
		if (!turnOptions) {
			state.registry.markFinished(next.runId, {
				error: 'Run options were lost before the run could start',
				ok: false,
				status: 'failed',
			});
			continue;
		}
		void executeRun(state, next.runId, turnOptions);
	}
}

async function executeRun(state, runId, turnOptions) {
	const { registry } = state;
	registry.markRunning(runId);
	const io = createRunIo(state, runId);
	const options = {
		...turnOptions,
		onProgress(event) {
			if (!registry.get(runId)) {
				return;
			}
			registry.recordEvent(runId, 'progress', event);
			const phase = phaseForProgressEvent(event);
			if (phase !== null) {
				registry.setPhase(runId, phase);
			}
		},
	};
	try {
		const result = await state.channel({ kind: 'run-turn', options }, io);
		if (result && typeof result.runDir === 'string' && result.runDir) {
			state.runDirs.set(runId, resolve(state.cwd, result.runDir));
		}
		registry.markFinished(runId, {
			cost: result?.usage?.costUsd ?? result?.usage?.cost ?? null,
			exitReason:
				result?.loopBudget?.stopReason || result?.healStopReason || '',
			ok: result?.ok === true,
			runDir: displayRunDir(state.cwd, result?.runDir),
			sessionId: result?.sessionId || '',
			status: 'completed',
			usage: result?.usage ?? null,
		});
	} catch (error) {
		registry.markFinished(runId, {
			error: error instanceof Error ? error.message : String(error),
			ok: false,
			status: 'failed',
		});
	} finally {
		startQueuedRuns(state);
	}
}

function cancelRun(state, runId) {
	const before = state.registry.get(runId);
	const wasFinal = isFinalStatus(before.status);
	if (!wasFinal && before.status === 'queued') {
		state.pendingTurnOptions.delete(runId);
	}
	const run = state.registry.requestCancel(runId);
	return {
		bestEffort: true,
		cancelRequested: run.cancelRequested,
		message: wasFinal
			? `Run already finished with status ${run.status}`
			: run.status === 'cancelled'
				? 'Queued run cancelled before it started'
				: 'Cancellation requested; the active run finishes its current operation. Cancellation is best-effort in this version.',
		runId,
		status: run.status,
	};
}

function handleRunEvents(request, response, state, runId) {
	response.writeHead(200, {
		'cache-control': 'no-cache',
		connection: 'keep-alive',
		'content-type': 'text/event-stream; charset=utf-8',
	});
	const lastEventId = Number(request.headers['last-event-id']) || 0;
	const writeEvent = (event) => {
		response.write(
			`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
		);
	};

	for (const event of state.registry.eventsSince(runId, lastEventId)) {
		writeEvent(event);
	}
	if (isFinalStatus(state.registry.get(runId).status)) {
		response.end();
		return;
	}

	const unsubscribe = state.registry.subscribe(runId, (event) => {
		writeEvent(event);
		if (event.type === 'done') {
			unsubscribe();
			response.end();
		}
	});
	request.on('close', unsubscribe);
}

async function listRunArtifacts(state, runId) {
	const runDir = state.runDirs.get(runId);
	if (!runDir) {
		return {
			artifacts: [],
			note: 'No run directory is recorded yet; artifacts appear when the run finishes.',
			runId,
		};
	}
	let names = [];
	try {
		names = await readdir(runDir);
	} catch {
		names = [];
	}
	return {
		artifacts: names.filter((name) => ARTIFACT_ALLOWLIST.has(name)).sort(),
		runId,
	};
}

async function serveRunArtifact(response, state, runId, name) {
	const run = state.registry.get(runId);
	if (!run) {
		writeJson(response, 404, { error: `Unknown run: ${runId}` });
		return;
	}
	if (!ARTIFACT_ALLOWLIST.has(name)) {
		writeJson(response, 403, { error: `Artifact not allowlisted: ${name}` });
		return;
	}
	const runDir = state.runDirs.get(runId);
	if (!runDir) {
		writeJson(response, 404, { error: 'No run directory recorded yet' });
		return;
	}
	const artifactPath = resolve(runDir, name);
	if (!artifactPath.startsWith(runDir + sep)) {
		writeJson(response, 403, {
			error: 'Artifact path escapes the run directory',
		});
		return;
	}
	let body;
	try {
		body = await readFile(artifactPath);
	} catch {
		writeJson(response, 404, { error: `Artifact not found: ${name}` });
		return;
	}
	const extension = name.slice(name.lastIndexOf('.'));
	response.writeHead(200, {
		'content-length': body.byteLength,
		'content-type':
			ARTIFACT_CONTENT_TYPES.get(extension) || 'text/plain; charset=utf-8',
	});
	response.end(body);
}

function createRunTurnOptions(options, body, sessionId) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new HttpError(400, 'Run submission requires a JSON object body');
	}
	const unknown = Object.keys(body).filter((key) => !RUN_BODY_FIELDS.has(key));
	if (unknown.length > 0) {
		throw new HttpError(400, `Unknown run fields: ${unknown.join(', ')}`);
	}
	if (body.test !== undefined && typeof body.test !== 'string') {
		throw new HttpError(400, 'test must be a string when provided');
	}
	if (body.install !== undefined && typeof body.install !== 'boolean') {
		throw new HttpError(400, 'install must be a boolean when provided');
	}
	if (
		body.subagentStages !== undefined &&
		typeof body.subagentStages !== 'boolean'
	) {
		throw new HttpError(400, 'subagentStages must be a boolean when provided');
	}

	const turnOptions = createTurnOptions(
		options,
		sessionId ? { ...body, sessionId } : body,
		'/runs',
	);
	if (typeof body.test === 'string' && body.test.length > 0) {
		turnOptions.testCommand = body.test;
	} else {
		turnOptions.testCommand = '';
	}
	turnOptions.installDependencies = body.install === true;
	turnOptions.subagentStages = body.subagentStages === true;
	return turnOptions;
}

function createTurnOptions(options, body, route) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new HttpError(400, `POST ${route} requires a JSON object body`);
	}
	if (typeof body.prompt !== 'string' || body.prompt.length === 0) {
		throw new HttpError(
			400,
			`POST ${route} requires a non-empty prompt string`,
		);
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
	if (body.model !== undefined && typeof body.model !== 'string') {
		throw new HttpError(400, 'model must be a string when provided');
	}
	if (body.tools !== undefined && typeof body.tools !== 'boolean') {
		throw new HttpError(400, 'tools must be a boolean when provided');
	}
	if (body.yes !== undefined && typeof body.yes !== 'boolean') {
		throw new HttpError(400, 'yes must be a boolean when provided');
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

function createRunIo(state, runId) {
	const sink = { write() {} };
	return {
		cwd: state.cwd,
		env: process.env,
		stderr: {
			write: (chunk) => {
				const line = String(chunk).trimEnd();
				if (line && state.registry.get(runId)) {
					state.registry.recordEvent(runId, 'log', { line });
				}
			},
		},
		stdout: sink,
	};
}

function displayRunDir(cwd, runDir) {
	if (typeof runDir !== 'string' || !runDir) {
		return '';
	}
	const relativePath = relative(cwd, resolve(cwd, runDir));
	return relativePath.startsWith('..') ? runDir : relativePath;
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
