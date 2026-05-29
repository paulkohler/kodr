import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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

async function startTestServer(channel) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-server-test-'));
	const options = testOptions();
	const server = await startKodrServer({
		channel,
		cwd,
		options,
	});
	return { ...server, options };
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
