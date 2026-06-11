import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { handleChannelRequest, main, parseArgs } from '../src/app.mjs';
import { undoLastApply } from '../src/undo.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

// Build a minimal Readable stdin that emits the given text then ends.
function makeTtyStdin(answer) {
	const readable = new Readable({ read() {} });
	readable.isTTY = true;
	if (answer !== null) {
		readable.push(`${answer}\n`);
	}
	readable.push(null);
	return readable;
}

function makeTtyStdout() {
	return {
		isTTY: true,
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}

function captureStream() {
	return {
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}

function proposalResponse(value) {
	return {
		choices: [
			{
				finish_reason: 'stop',
				message: { content: JSON.stringify(value), role: 'assistant' },
			},
		],
		id: 'chatcmpl_proposal',
		object: 'chat.completion',
	};
}

function singleFileProposal() {
	return proposalResponse({
		files: [{ content: 'export const x = 1;\n', path: 'out.mjs' }],
		messages: [{ content: 'Added a constant.', level: 'info' }],
		status: 'OK',
	});
}

// Base args used in all TTY run tests. --no-stream avoids SSE which the fake
// model server does not speak; the TTY flags on io are what trigger the prompt.
const BASE_ARGS = ['--timeout-ms', '5000', '--no-stream'];

describe('interactive apply prompt', () => {
	it('_dryRunSet is false by default and true only with --dry-run', () => {
		const defaults = parseArgs([], {});
		assert.equal(defaults._dryRunSet, false);
		assert.equal(defaults.dryRun, true);

		const explicit = parseArgs(['run', '--dry-run'], {});
		assert.equal(explicit._dryRunSet, true);
		assert.equal(explicit.dryRun, true);

		const yesFlag = parseArgs(['run', '--yes'], {});
		assert.equal(yesFlag._dryRunSet, false);
		assert.equal(yesFlag.dryRun, false);
	});

	it('TTY run answering y applies and records prompt-accepted', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-y-'));
			const stdout = makeTtyStdout();
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
					stdin: makeTtyStdin('y'),
				},
			);

			assert.equal(result.result.applied, true, 'file should be applied');
			assert.equal(result.result.applyDecision, 'prompt-accepted');
			assert.equal(server.recordings.length, 1, 'exactly one model call');
			assert.equal(
				await readFile(join(cwd, 'out.mjs'), 'utf8'),
				'export const x = 1;\n',
			);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.applied, true);
			assert.equal(summary.applyDecision, 'prompt-accepted');

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.equal(writes.applied, true);
		} finally {
			await server.close();
		}
	});

	it('TTY run answering yes (full word) applies', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-yes-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin('yes'),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(result.result.applyDecision, 'prompt-accepted');
		} finally {
			await server.close();
		}
	});

	it('TTY run answering n declines and records prompt-declined', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-n-'));
			const stdout = makeTtyStdout();
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
					stdin: makeTtyStdin('n'),
				},
			);

			assert.equal(result.result.applied, false);
			assert.equal(result.result.applyDecision, 'prompt-declined');
			assert.match(stdout.text, /dry-run \(declined\)/u);
			assert.match(stdout.text, /Apply declined\./u);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.applied, false);
			assert.equal(summary.applyDecision, 'prompt-declined');
		} finally {
			await server.close();
		}
	});

	it('TTY run with empty answer declines', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-empty-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin(''),
				},
			);

			assert.equal(result.result.applied, false);
			assert.equal(result.result.applyDecision, 'prompt-declined');
		} finally {
			await server.close();
		}
	});

	it('TTY run with EOF (null stdin) declines', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-eof-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin(null),
				},
			);

			assert.equal(result.result.applied, false);
			assert.equal(result.result.applyDecision, 'prompt-declined');
		} finally {
			await server.close();
		}
	});

	it('non-TTY stdout never prompts — records none', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-notty-'));
			// captureStream has no isTTY property (undefined = falsy)
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.equal(result.result.applied, false);
			assert.equal(result.result.applyDecision, 'none');
		} finally {
			await server.close();
		}
	});

	it('--json flag skips the prompt — records none', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-json-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
					stdin: makeTtyStdin('y'),
				},
			);

			assert.equal(result.result.applied, false);
			assert.equal(result.result.applyDecision, 'none');
		} finally {
			await server.close();
		}
	});

	it('--yes skips the prompt and records flag', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-yes-flag-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
					'--yes',
					'--no-stream',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin('n'),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(result.result.applyDecision, 'flag');
		} finally {
			await server.close();
		}
	});

	it('explicit --dry-run skips the prompt and records none', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-dryrun-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
					'--dry-run',
					'--no-stream',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin('y'),
				},
			);

			assert.equal(result.result.applied, false);
			assert.equal(result.result.applyDecision, 'none');
		} finally {
			await server.close();
		}
	});

	it('prompt-accepted run is found by undoLastApply', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-undo-'));
			await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin('y'),
				},
			);

			const undoResult = await undoLastApply(cwd);
			assert.equal(
				undoResult.ok,
				true,
				`undo should succeed: ${undoResult.message}`,
			);
			assert.equal(undoResult.files.length, 1);
			assert.equal(undoResult.files[0].action, 'delete');
		} finally {
			await server.close();
		}
	});

	it('post-accept pipeline runs verification when --test is set', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-test-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					...BASE_ARGS,
					'--test',
					'node --check out.mjs',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: makeTtyStdout(),
					stdin: makeTtyStdin('y'),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(result.result.tested, true);

			const tests = JSON.parse(
				await readFile(join(result.result.runDir, 'tests.json'), 'utf8'),
			);
			assert.equal(tests.ok, true);
		} finally {
			await server.close();
		}
	});

	it('apply-proposal channel request updates writes.json so /undo can find the run', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: singleFileProposal(),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-iapply-tui-undo-'));
			// Simulate a dry-run (as TUI does), then a late apply-proposal request.
			const dryResult = await main(
				[
					'run',
					'-p',
					'Create out.mjs',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			assert.equal(dryResult.result.applied, false, 'dry run should not apply');

			// Simulate TUI /accept sending an apply-proposal request.
			await handleChannelRequest(
				{
					kind: 'apply-proposal',
					proposal: dryResult.result.proposal,
					runDir: dryResult.result.runDir,
					sessionId: dryResult.result.sessionId,
					options: {},
				},
				{ cwd },
			);

			// Now /undo should find it.
			const undoResult = await undoLastApply(cwd);
			assert.equal(
				undoResult.ok,
				true,
				`undo should succeed after TUI accept: ${undoResult.message}`,
			);
		} finally {
			await server.close();
		}
	});

	it('channel permission-request still denies when no approver', async () => {
		const result = await handleChannelRequest(
			{
				kind: 'permission-request',
				request: {
					action: 'read_file',
					input: { path: 'foo.txt' },
					reason: 'test',
					status: 'pending',
				},
			},
			{ cwd: process.cwd() },
		);

		assert.equal(result.decision, 'deny');
		assert.match(result.reason, /No interactive permission approver/u);
	});
});
