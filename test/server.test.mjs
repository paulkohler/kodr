import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startKodrServer } from '../src/server.mjs';

describe('startKodrServer', () => {
	it('serves session lists through the channel handler', async () => {
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			return [
				{
					lastTimestamp: '2026-05-29T00:00:00.000Z',
					model: 'test-model',
					ok: true,
					sessionId: 'session-a',
					turnCount: 1,
				},
			];
		});

		try {
			const response = await fetch(`${server.url}/sessions`);
			const body = await response.json();

			assert.equal(response.status, 200);
			assert.deepEqual(body.sessions, [
				{
					lastTimestamp: '2026-05-29T00:00:00.000Z',
					model: 'test-model',
					ok: true,
					sessionId: 'session-a',
					turnCount: 1,
				},
			]);
			assert.equal(calls[0].kind, 'session-list');
		} finally {
			await server.close();
		}
	});

	it('serves a session conversation through the channel handler', async () => {
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			return {
				sessionId: request.sessionId,
				turns: [{ assistant: 'pong', model: 'test-model', user: 'ping' }],
			};
		});

		try {
			const response = await fetch(`${server.url}/sessions/session-a`);
			const body = await response.json();

			assert.equal(response.status, 200);
			assert.equal(body.sessionId, 'session-a');
			assert.equal(body.turns[0].assistant, 'pong');
			assert.deepEqual(
				calls.map((call) => call.kind),
				['session-show'],
			);
			assert.equal(calls[0].sessionId, 'session-a');
		} finally {
			await server.close();
		}
	});

	it('runs turns through the channel handler', async () => {
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			return {
				assistant: 'done',
				ok: true,
				runDir: '.kodr/runs/test',
			};
		});

		try {
			const response = await fetch(`${server.url}/turn`, {
				body: JSON.stringify({
					model: 'override-model',
					prompt: 'Build a small app',
					sessionId: 'session-a',
					tools: true,
					yes: true,
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const body = await response.json();

			assert.equal(response.status, 200);
			assert.equal(body.ok, true);
			assert.equal(calls[0].kind, 'run-turn');
			assert.equal(calls[0].options.prompt, 'Build a small app');
			assert.equal(calls[0].options.sessionId, 'session-a');
			assert.equal(calls[0].options.model, 'override-model');
			assert.equal(calls[0].options.tools, true);
			assert.equal(calls[0].options.dryRun, false);
			assert.equal(calls[0].options.yes, true);
		} finally {
			await server.close();
		}
	});

	it('defaults web turns to dry-run even when server options carry session state', async () => {
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			return { ok: true };
		});
		server.options.sessionId = 'server-session';
		server.options.continueSession = true;
		server.options.yes = true;
		server.options.dryRun = false;

		try {
			const response = await fetch(`${server.url}/turn`, {
				body: JSON.stringify({ prompt: 'Plan only' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});

			assert.equal(response.status, 200);
			assert.equal(calls[0].options.sessionId, '');
			assert.equal(calls[0].options.continueSession, false);
			assert.equal(calls[0].options.dryRun, true);
			assert.equal(calls[0].options.yes, false);
		} finally {
			await server.close();
		}
	});

	it('rejects bad turn requests', async () => {
		const server = await startTestServer(async () => {
			throw new Error('channel should not be called');
		});

		try {
			const invalidJson = await fetch(`${server.url}/turn`, {
				body: '{',
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const missingPrompt = await fetch(`${server.url}/turn`, {
				body: JSON.stringify({}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});

			assert.equal(invalidJson.status, 400);
			assert.equal(missingPrompt.status, 400);
		} finally {
			await server.close();
		}
	});

	it('maps missing sessions to 404', async () => {
		const server = await startTestServer(async () => {
			throw new Error('Session not found: missing');
		});

		try {
			const response = await fetch(`${server.url}/sessions/missing`);
			const body = await response.json();

			assert.equal(response.status, 404);
			assert.equal(body.error, 'Session not found: missing');
		} finally {
			await server.close();
		}
	});

	it('stays local-only', async () => {
		await assert.rejects(
			() =>
				startKodrServer({
					channel: async () => ({}),
					cwd: process.cwd(),
					options: { serveHost: '0.0.0.0', servePort: 0 },
				}),
			/local-only/u,
		);
	});
});

describe('async run routes', () => {
	it('answers health and status', async () => {
		const server = await startTestServer(async () => ({}));

		try {
			const health = await (await fetch(`${server.url}/health`)).json();
			const status = await (await fetch(`${server.url}/status`)).json();

			assert.equal(health.ok, true);
			assert.equal(status.ok, true);
			assert.equal(status.activeRuns, 0);
			assert.equal(status.queuedRuns, 0);
			assert.equal(status.maxActiveRuns, 1);
			assert.ok(status.startedAt);
		} finally {
			await server.close();
		}
	});

	it('submits a run, exposes running state, and completes through the channel', async () => {
		const gate = deferred();
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			await gate.promise;
			return {
				loopBudget: { stopReason: 'completed' },
				ok: true,
				runDir: '.kodr/runs/run-a',
				sessionId: 'run-a',
				usage: { cost: 0, totalTokens: 42 },
			};
		});

		try {
			const submitResponse = await fetch(`${server.url}/runs`, {
				body: JSON.stringify({ prompt: 'Create src/math.mjs with add()' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const submitted = await submitResponse.json();

			assert.equal(submitResponse.status, 202);
			assert.ok(submitted.runId);
			assert.equal(submitted.eventsUrl, `/runs/${submitted.runId}/events`);
			assert.equal(submitted.statusUrl, `/runs/${submitted.runId}`);

			const running = await fetchRun(server.url, submitted.runId);
			assert.equal(running.status, 'running');
			assert.equal(calls[0].kind, 'run-turn');
			assert.equal(calls[0].options.dryRun, true);
			assert.equal(calls[0].options.yes, false);
			assert.equal(typeof calls[0].options.onProgress, 'function');

			gate.resolve();
			const finished = await waitFor(async () => {
				const run = await fetchRun(server.url, submitted.runId);
				return run.status === 'completed' ? run : null;
			});

			assert.equal(finished.ok, true);
			assert.equal(finished.runDir, '.kodr/runs/run-a');
			assert.equal(finished.sessionId, 'run-a');
			assert.equal(finished.exitReason, 'completed');
			assert.equal(finished.usage.totalTokens, 42);

			const list = await (await fetch(`${server.url}/runs`)).json();
			assert.equal(list.runs.length, 1);
			assert.equal(list.runs[0].runId, submitted.runId);
		} finally {
			gate.resolve();
			await server.close();
		}
	});

	it('rejects unknown run fields and bad types', async () => {
		const server = await startTestServer(async () => {
			throw new Error('channel should not be called');
		});

		try {
			const unknownField = await fetch(`${server.url}/runs`, {
				body: JSON.stringify({ outDir: '/etc', prompt: 'x' }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const badTest = await fetch(`${server.url}/runs`, {
				body: JSON.stringify({ prompt: 'x', test: 42 }),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			const missingPrompt = await fetch(`${server.url}/runs`, {
				body: JSON.stringify({}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});

			assert.equal(unknownField.status, 400);
			assert.match((await unknownField.json()).error, /Unknown run fields/u);
			assert.equal(badTest.status, 400);
			assert.equal(missingPrompt.status, 400);
		} finally {
			await server.close();
		}
	});

	it('maps run fields onto typed channel options and stays dry-run by default', async () => {
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			return { ok: true, runDir: '', sessionId: '' };
		});

		try {
			await fetch(`${server.url}/runs`, {
				body: JSON.stringify({
					install: true,
					model: 'override-model',
					prompt: 'task',
					subagentStages: true,
					test: 'npm test',
					tools: true,
				}),
				headers: { 'content-type': 'application/json' },
				method: 'POST',
			});
			await waitFor(async () => calls.length === 1);

			const options = calls[0].options;
			assert.equal(options.testCommand, 'npm test');
			assert.equal(options.installDependencies, true);
			assert.equal(options.subagentStages, true);
			assert.equal(options.tools, true);
			assert.equal(options.model, 'override-model');
			assert.equal(options.dryRun, true);
			assert.equal(options.yes, false);
		} finally {
			await server.close();
		}
	});

	it('queues a second run while the first is active and starts it after', async () => {
		const firstGate = deferred();
		let callCount = 0;
		const server = await startTestServer(async () => {
			callCount += 1;
			if (callCount === 1) {
				await firstGate.promise;
			}
			return { ok: true, runDir: '', sessionId: '' };
		});

		try {
			const first = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'first' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();
			const second = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'second' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();

			assert.equal(second.status, 'queued');
			const queued = await fetchRun(server.url, second.runId);
			assert.match(queued.queueReason, /active run slot/u);

			const status = await (await fetch(`${server.url}/status`)).json();
			assert.equal(status.activeRuns, 1);
			assert.equal(status.queuedRuns, 1);

			firstGate.resolve();
			const finishedSecond = await waitFor(async () => {
				const run = await fetchRun(server.url, second.runId);
				return run.status === 'completed' ? run : null;
			});
			assert.equal(finishedSecond.ok, true);
			const finishedFirst = await fetchRun(server.url, first.runId);
			assert.equal(finishedFirst.status, 'completed');
		} finally {
			firstGate.resolve();
			await server.close();
		}
	});

	it('streams progress and done events over SSE with replay', async () => {
		const gate = deferred();
		let capturedOptions = null;
		const server = await startTestServer(async (request) => {
			capturedOptions = request.options;
			await gate.promise;
			return { ok: true, runDir: '.kodr/runs/sse', sessionId: 'sse' };
		});

		try {
			const submitted = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'stream me' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();

			const eventsResponse = await fetch(`${server.url}${submitted.eventsUrl}`);
			assert.match(
				eventsResponse.headers.get('content-type') || '',
				/text\/event-stream/u,
			);
			const streamed = eventsResponse.text();

			await waitFor(async () => capturedOptions !== null);
			capturedOptions.onProgress({
				agent: 'standard',
				event: 'agent_start',
				model: 'test-model',
			});
			gate.resolve();

			const body = await streamed;
			assert.match(body, /event: status\ndata: \{"status":"queued"\}/u);
			assert.match(body, /event: status\ndata: \{"status":"running"\}/u);
			assert.match(body, /event: progress\n/u);
			assert.match(body, /"event":"agent_start"/u);
			assert.match(body, /event: done\n/u);
			assert.match(body, /"status":"completed"/u);

			const lateReplay = await (
				await fetch(`${server.url}${submitted.eventsUrl}`)
			).text();
			assert.match(lateReplay, /event: done\n/u);

			const partialReplay = await (
				await fetch(`${server.url}${submitted.eventsUrl}`, {
					headers: { 'last-event-id': '2' },
				})
			).text();
			assert.doesNotMatch(partialReplay, /"status":"queued"/u);
			assert.match(partialReplay, /event: done\n/u);

			const logs = await (
				await fetch(`${server.url}/runs/${submitted.runId}/logs`)
			).json();
			assert.ok(logs.logs.length >= 3);
			assert.equal(logs.logs[0].type, 'status');
		} finally {
			gate.resolve();
			await server.close();
		}
	});

	it('drives a second turn on the same session via POST /sessions/:id/turns', async () => {
		const calls = [];
		const server = await startTestServer(async (request) => {
			calls.push(request);
			return { ok: true, runDir: '', sessionId: 'session-a' };
		});

		try {
			const submitted = await (
				await fetch(`${server.url}/sessions/session-a/turns`, {
					body: JSON.stringify({ prompt: 'Add subtract() and tests' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();
			await waitFor(async () => calls.length === 1);

			assert.equal(submitted.sessionId, 'session-a');
			assert.equal(calls[0].options.sessionId, 'session-a');

			const conflicting = await fetch(
				`${server.url}/sessions/session-a/turns`,
				{
					body: JSON.stringify({ prompt: 'x', sessionId: 'other' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				},
			);
			assert.equal(conflicting.status, 400);
		} finally {
			await server.close();
		}
	});

	it('lists and serves only allowlisted artifacts from the run directory', async () => {
		let cwd = '';
		const server = await startTestServer(async () => {
			const runDir = join(cwd, '.kodr', 'runs', 'run-a');
			await mkdir(runDir, { recursive: true });
			await writeFile(join(runDir, 'summary.json'), '{"ok":true}');
			await writeFile(join(runDir, 'secret.txt'), 'do not serve');
			return { ok: true, runDir, sessionId: 'run-a' };
		});
		cwd = server.cwd;

		try {
			const submitted = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'task' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();
			await waitFor(async () => {
				const run = await fetchRun(server.url, submitted.runId);
				return run.status === 'completed';
			});

			const listing = await (
				await fetch(`${server.url}/runs/${submitted.runId}/artifacts`)
			).json();
			assert.deepEqual(listing.artifacts, ['summary.json']);

			const artifact = await fetch(
				`${server.url}/runs/${submitted.runId}/artifacts/summary.json`,
			);
			assert.equal(artifact.status, 200);
			assert.match(
				artifact.headers.get('content-type') || '',
				/application\/json/u,
			);
			assert.deepEqual(await artifact.json(), { ok: true });

			const denied = await fetch(
				`${server.url}/runs/${submitted.runId}/artifacts/secret.txt`,
			);
			assert.equal(denied.status, 403);

			const traversal = await fetch(
				`${server.url}/runs/${submitted.runId}/artifacts/..%2Fsummary.json`,
			);
			assert.equal(traversal.status, 403);

			const missing = await fetch(
				`${server.url}/runs/${submitted.runId}/artifacts/tests.json`,
			);
			assert.equal(missing.status, 404);
		} finally {
			await server.close();
		}
	});

	it('cancels queued runs and reports best-effort for running runs', async () => {
		const gate = deferred();
		const server = await startTestServer(async () => {
			await gate.promise;
			return { ok: true, runDir: '', sessionId: '' };
		});

		try {
			const active = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'active' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();
			const queued = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'queued' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();

			const cancelQueued = await (
				await fetch(`${server.url}/runs/${queued.runId}/cancel`, {
					method: 'POST',
				})
			).json();
			assert.equal(cancelQueued.status, 'cancelled');
			assert.equal(cancelQueued.bestEffort, true);

			const cancelActive = await (
				await fetch(`${server.url}/runs/${active.runId}/cancel`, {
					method: 'POST',
				})
			).json();
			assert.equal(cancelActive.status, 'running');
			assert.equal(cancelActive.cancelRequested, true);
			assert.match(cancelActive.message, /best-effort/u);

			gate.resolve();
			const finished = await waitFor(async () => {
				const run = await fetchRun(server.url, active.runId);
				return run.status === 'completed' ? run : null;
			});
			assert.equal(finished.cancelRequested, true);

			const cancelFinished = await (
				await fetch(`${server.url}/runs/${active.runId}/cancel`, {
					method: 'POST',
				})
			).json();
			assert.match(cancelFinished.message, /already finished/u);
		} finally {
			gate.resolve();
			await server.close();
		}
	});

	it('marks failed channel runs as failed with the error recorded', async () => {
		const server = await startTestServer(async () => {
			throw new Error('model exploded');
		});

		try {
			const submitted = await (
				await fetch(`${server.url}/runs`, {
					body: JSON.stringify({ prompt: 'task' }),
					headers: { 'content-type': 'application/json' },
					method: 'POST',
				})
			).json();
			const failed = await waitFor(async () => {
				const run = await fetchRun(server.url, submitted.runId);
				return run.status === 'failed' ? run : null;
			});

			assert.equal(failed.ok, false);
			assert.equal(failed.error, 'model exploded');
		} finally {
			await server.close();
		}
	});

	it('returns 404 for unknown runs', async () => {
		const server = await startTestServer(async () => ({}));

		try {
			const response = await fetch(`${server.url}/runs/run-missing`);
			assert.equal(response.status, 404);
		} finally {
			await server.close();
		}
	});
});

async function startTestServer(channel) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-server-test-'));
	const options = testOptions();
	const server = await startKodrServer({
		channel,
		cwd,
		options,
	});
	return { ...server, cwd, options };
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, reject, resolve };
}

async function waitFor(check, timeoutMs = 2000) {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		const value = await check();
		if (value) {
			return value;
		}
		await new Promise((res) => setTimeout(res, 10));
	}
	throw new Error('waitFor timed out');
}

async function fetchRun(serverUrl, runId) {
	const response = await fetch(`${serverUrl}/runs/${runId}`);
	return response.json();
}

function testOptions() {
	return {
		baseUrl: 'http://localhost:1234/v1',
		dryRun: true,
		model: 'test-model',
		serveHost: '127.0.0.1',
		servePort: 0,
		timeoutMs: 1000,
	};
}
