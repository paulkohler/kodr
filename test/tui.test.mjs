import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { main } from '../src/app.mjs';
import { createTuiState, handleTuiLine, runTui } from '../src/tui.mjs';

describe('terminal turn ui', () => {
	it('routes normal input through the run-turn channel request', async () => {
		const state = createTuiState({
			model: 'test-model',
			provider: 'local',
			timeoutMs: 1000,
		});
		const calls = [];
		const stdout = captureStream();

		const result = await handleTuiLine(
			state,
			'write a parser',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					applied: false,
					ok: true,
					response: 'Plain response.',
					runDir: '/tmp/run-1',
					sessionId: 'run-1',
					writeResult: { writes: [] },
				};
			},
		);

		assert.equal(result.type, 'turn');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, 'run-turn');
		assert.equal(calls[0].options.prompt, 'write a parser');
		assert.equal(calls[0].options.model, 'test-model');
		assert.equal(calls[0].options.sessionId, '');
		assert.equal(state.sessionId, 'run-1');
		assert.match(stdout.text, /Plain response/u);
	});

	it('keeps slash commands out of the model channel', async () => {
		const state = createTuiState({ model: 'test-model' });
		let calls = 0;
		const stdout = captureStream();

		await handleTuiLine(state, '/apply on', { stdout }, async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/tools on', { stdout }, async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/model other-model', { stdout }, async () => {
			calls += 1;
		});

		assert.equal(calls, 0);
		assert.equal(state.apply, true);
		assert.equal(state.tools, true);
		assert.equal(state.model, 'other-model');
	});

	it('selects sessions and sends following turns through that session', async () => {
		const state = createTuiState({ model: 'test-model' });
		const calls = [];

		await handleTuiLine(
			state,
			'/use session-a',
			captureIo(),
			async (request) => {
				calls.push(request);
			},
		);
		await handleTuiLine(state, 'follow up', captureIo(), async (request) => {
			calls.push(request);
			return {
				applied: false,
				ok: true,
				response: 'ok',
				runDir: '/tmp/run-2',
				sessionId: 'session-a',
				writeResult: { writes: [] },
			};
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, 'run-turn');
		assert.equal(calls[0].options.sessionId, 'session-a');
	});

	it('runs an interactive quit loop from main', async () => {
		const stdout = captureStream();
		const result = await main(['tui'], {
			cwd: process.cwd(),
			env: {},
			stderr: captureStream(),
			stdin: Readable.from(['/quit\n']),
			stdout,
		});

		assert.equal(result.command, 'tui');
		assert.equal(result.ok, true);
		assert.match(stdout.text, /kodr /u);
		assert.match(stdout.text, /assistant> bye/u);
	});

	it('exits cleanly when piped input ends after a turn', async () => {
		const stdout = captureStream();
		const result = await runTui(
			{ model: 'test-model' },
			{
				stderr: captureStream(),
				stdin: Readable.from(['one turn\n']),
				stdout,
			},
			async () => {
				return {
					applied: false,
					ok: true,
					response: 'done',
					runDir: '/tmp/run-eof',
					sessionId: 'run-eof',
					writeResult: { writes: [] },
				};
			},
		);

		assert.equal(result.ok, true);
		assert.equal(result.reason, 'eof');
		assert.match(stdout.text, /done/u);
	});

	it('lists and shows sessions through slash commands', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, '/sessions', { stdout }, async (request) => {
			calls.push(request);
			return [
				{
					model: 'test-model',
					ok: true,
					sessionId: 'session-a',
					turnCount: 2,
				},
			];
		});
		await handleTuiLine(
			state,
			'/show session-a',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					sessionId: 'session-a',
					turns: [{ assistant: 'hello', user: 'hi' }],
				};
			},
		);

		assert.deepEqual(
			calls.map((call) => call.kind),
			['session-list', 'session-show'],
		);
		assert.match(stdout.text, /session-a/u);
		assert.match(stdout.text, /assistant: hello/u);
	});

	it('stores pending reviews for dry-run write proposals', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		await handleTuiLine(state, 'change a file', { stdout }, async () => {
			return proposalResult({ applied: false });
		});

		assert.ok(state.pendingReview);
		assert.equal(state.pendingReview.prompt, 'change a file');
		assert.match(stdout.text, /pending review/u);
		assert.match(stdout.text, /src\/index.mjs/u);
	});

	it('accepts a pending review through a second run-turn request', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, 'change a file', { stdout }, async (request) => {
			calls.push(request);
			return proposalResult({ applied: false });
		});
		await handleTuiLine(state, '/accept', { stdout }, async (request) => {
			calls.push(request);
			return proposalResult({
				applied: true,
				runDir: '/tmp/run-applied',
				sessionId: 'applied-session',
			});
		});

		assert.equal(calls.length, 2);
		assert.equal(calls[1].kind, 'run-turn');
		assert.equal(calls[1].options.yes, true);
		assert.equal(calls[1].options.dryRun, false);
		assert.equal(state.pendingReview, null);
		assert.equal(state.sessionId, 'applied-session');
		assert.match(stdout.text, /applying pending review/u);
	});

	it('rejects and reprints pending reviews without model calls', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		let calls = 0;

		await handleTuiLine(state, 'change a file', { stdout }, async () => {
			calls += 1;
			return proposalResult({ applied: false });
		});
		await handleTuiLine(state, '/review', { stdout }, async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/reject', { stdout }, async () => {
			calls += 1;
		});

		assert.equal(calls, 1);
		assert.equal(state.pendingReview, null);
		assert.match(stdout.text, /review rejected/u);
	});

	it('runs configured pending-review tests through the channel', async () => {
		const state = createTuiState({
			model: 'test-model',
			testCommand: 'npm test',
		});
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, 'change a file', { stdout }, async (request) => {
			calls.push(request);
			return proposalResult({ applied: false });
		});
		await handleTuiLine(state, '/test', { stdout }, async (request) => {
			calls.push(request);
			return { command: 'npm test', ok: true };
		});

		assert.deepEqual(
			calls.map((call) => call.kind),
			['run-turn', 'verify-command'],
		);
		assert.match(stdout.text, /tests=passed/u);
	});
});

function proposalResult(options = {}) {
	return {
		applied: options.applied ?? false,
		ok: true,
		proposal: {
			messages: [{ content: 'Ready to apply.', level: 'info' }],
		},
		runDir: options.runDir || '/tmp/run-dry',
		sessionId: options.sessionId || 'dry-session',
		writeResult: {
			writes: [{ path: 'src/index.mjs', status: 'modify' }],
		},
	};
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
