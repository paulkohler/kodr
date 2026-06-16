import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import { handleChannelRequest, main, parseArgs } from '../src/app.mjs';
import { createTuiState, handleTuiLine } from '../src/tui.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('channel contract', () => {
	it('CLI and channel run turns produce equivalent artifact shapes', async () => {
		const server = await startFakeModelServer({
			responses: [chatResponse('CLI answer.'), chatResponse('Channel answer.')],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-channel-shape-'));
			const io = {
				cwd,
				env: {},
				stderr: captureStream(),
				stdout: captureStream(),
			};

			// --dry-run on both so the CLI path (which applies by default as of
			// phase 151) and the raw channel run-turn share the same apply mode and
			// thus the same artifact shape — the contract under test.
			const cli = await main(
				[
					'run',
					'-p',
					'Do the thing.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--out',
					'cli-run',
					'--dry-run',
				],
				io,
			);
			const channelOptions = parseArgs([
				'run',
				'-p',
				'Do the thing.',
				'--base-url',
				server.baseUrl,
				'--timeout-ms',
				'1000',
				'--out',
				'channel-run',
				'--dry-run',
			]);
			const channel = await handleChannelRequest(
				{ kind: 'run-turn', options: channelOptions },
				{ ...io, stdout: captureStream() },
			);

			const cliSummary = await readSummary(cli.result.runDir);
			const channelSummary = await readSummary(channel.runDir);
			assert.deepEqual(
				Object.keys(channelSummary).sort(),
				Object.keys(cliSummary).sort(),
			);
			assert.deepEqual(
				Object.keys(channelSummary.artifacts).sort(),
				Object.keys(cliSummary.artifacts).sort(),
			);
			assert.equal(channelSummary.artifacts.conversation, 'conversation.json');
			assert.equal(channelSummary.artifacts.rawResponse, 'raw-response.json');
		} finally {
			await server.close();
		}
	});

	it('session list and show are available through presentation-neutral channel requests', async () => {
		const server = await startFakeModelServer({
			responses: [chatResponse('Session answer.')],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-channel-session-'));
			await main(
				[
					'run',
					'-p',
					'Create session.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			const sessionId = basename(
				(await readFile(join(cwd, '.kodr', 'last-run'), 'utf8')).trim(),
			);

			const sessions = await handleChannelRequest(
				{ kind: 'session-list', options: {} },
				{ cwd },
			);
			const conversation = await handleChannelRequest(
				{ kind: 'session-show', options: {}, sessionId },
				{ cwd },
			);

			assert.equal(sessions.length, 1);
			assert.equal(sessions[0].sessionId, sessionId);
			assert.equal(conversation.sessionId, sessionId);
			assert.equal(conversation.turns[0].assistant, 'Session answer.');
		} finally {
			await server.close();
		}
	});

	it('rejects unknown channel requests clearly', async () => {
		await assert.rejects(
			() => handleChannelRequest({ kind: 'unknown' }, { cwd: process.cwd() }),
			/Unknown channel request/u,
		);
	});

	it('routes permission request and decision messages through the channel', async () => {
		const request = {
			action: 'run_command',
			input: { command: 'npm install' },
			reason: 'Command is denied by policy: npm install',
			status: 'pending',
		};

		const defaultDecision = await handleChannelRequest(
			{ kind: 'permission-request', request },
			{ cwd: process.cwd() },
		);
		const allowDecision = await handleChannelRequest(
			{ decision: 'allow', kind: 'permission-decision', request },
			{ cwd: process.cwd() },
		);
		const denyDecision = await handleChannelRequest(
			{
				decision: 'deny',
				kind: 'permission-decision',
				reason: 'not this time',
				request,
			},
			{ cwd: process.cwd() },
		);

		assert.equal(defaultDecision.status, 'denied');
		assert.equal(defaultDecision.decision, 'deny');
		assert.equal(allowDecision.status, 'approved');
		assert.equal(allowDecision.decision, 'allow');
		assert.equal(denyDecision.status, 'denied');
		assert.equal(denyDecision.reason, 'not this time');
	});

	it('TUI slash commands do not reach the run-turn channel', async () => {
		const state = createTuiState({ model: 'test-model' });
		let calls = 0;

		await handleTuiLine(state, '/status', captureIo(), async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/review', captureIo(), async () => {
			calls += 1;
		});

		assert.equal(calls, 0);
	});

	it('TUI turns do not mutate the base option template', async () => {
		const state = createTuiState({
			model: 'test-model',
			sessionId: 'session-a',
			testCommand: 'npm test',
		});
		const before = JSON.stringify(state.baseOptions);

		await handleTuiLine(state, 'follow up', captureIo(), async () => {
			return {
				applied: false,
				ok: true,
				response: 'ok',
				runDir: '/tmp/channel-run',
				sessionId: 'session-a',
				writeResult: { writes: [] },
			};
		});

		assert.equal(JSON.stringify(state.baseOptions), before);
	});
});

function chatResponse(content) {
	return {
		body: {
			choices: [
				{
					finish_reason: 'stop',
					message: { content, role: 'assistant' },
				},
			],
			id: 'chatcmpl_channel',
			object: 'chat.completion',
		},
		method: 'POST',
		status: 200,
		url: '/v1/chat/completions',
	};
}

async function readSummary(runDir) {
	return JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
}

function captureIo() {
	return { stdout: captureStream() };
}

function captureStream() {
	return {
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}
