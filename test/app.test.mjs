import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CliError, main, parseArgs, usage, VERSION } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('parseArgs', () => {
	it('starts with LM Studio-friendly defaults', () => {
		const options = parseArgs([], {});

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.timeoutMs, 600000);
	});

	it('parses model endpoint flags', () => {
		const options = parseArgs([
			'--base-url',
			'http://localhost:1234/v1/',
			'--model',
			'nvidia/nemotron-3-nano-omni',
			'--out',
			'custom-run',
			'--prompt-file',
			'prompt.md',
			'--api-key',
			'test-key',
			'--timeout-ms',
			'1000',
			'--json',
		]);

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.model, 'nvidia/nemotron-3-nano-omni');
		assert.equal(options.out, 'custom-run');
		assert.equal(options.promptFile, 'prompt.md');
		assert.equal(options.apiKey, 'test-key');
		assert.equal(options.timeoutMs, 1000);
		assert.equal(options.json, true);
	});

	it('rejects unknown options', () => {
		assert.throws(() => parseArgs(['--wat']), CliError);
	});
});

describe('usage', () => {
	it('mentions the current version and planned commands', () => {
		const text = usage();

		assert.match(text, new RegExp(VERSION));
		assert.match(text, /koder probe/u);
	});
});

describe('probe', () => {
	it('calls OpenAI-compatible endpoints and writes run artifacts', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-probe-'));
			const stdout = captureStream();
			const result = await main(
				[
					'probe',
					'--base-url',
					server.baseUrl,
					'--api-key',
					'secret-test-key',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.command, 'probe');
			assert.equal(result.result.model, 'fake-local-model');
			assert.equal(result.result.reply, 'koder-probe-ok');

			const output = JSON.parse(stdout.text);
			assert.equal(output.ok, true);
			assert.equal(output.model, 'fake-local-model');

			assert.deepEqual(
				server.recordings.map((recording) => {
					return `${recording.method} ${recording.url}`;
				}),
				['GET /v1/models', 'POST /v1/chat/completions'],
			);
			assert.equal(
				server.recordings[0].requestHeaders.authorization,
				'[redacted]',
			);
			assert.equal(
				server.recordings[1].requestHeaders.authorization,
				'[redacted]',
			);

			const chatRequest = server.recordings[1].requestBody;
			assert.equal(chatRequest.model, 'fake-local-model');
			assert.equal(chatRequest.messages[0].role, 'user');
			assert.equal(
				server.recordings[1].responseBody.choices[0].message.content,
				'koder-probe-ok',
			);

			const artifact = JSON.parse(
				await readFile(join(output.runDir, 'result.json'), 'utf8'),
			);
			assert.equal(artifact.ok, true);
			assert.equal(artifact.reply, 'koder-probe-ok');

			const chatResponse = JSON.parse(
				await readFile(join(output.runDir, 'chat-response.json'), 'utf8'),
			);
			assert.equal(chatResponse.status, 200);
		} finally {
			await server.close();
		}
	});

	it('fails when the model server returns invalid JSON', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: 'not json',
					method: 'GET',
					url: '/v1/models',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-probe-bad-json-'));

			await assert.rejects(
				() =>
					main(
						['probe', '--base-url', server.baseUrl, '--timeout-ms', '1000'],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/invalid JSON/u,
			);
		} finally {
			await server.close();
		}
	});
});

describe('run', () => {
	it('runs a prompt and writes inspectable artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'A compact answer.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_run',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-run-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Summarize the repo.',
					'--base-url',
					server.baseUrl,
					'--out',
					'run-output',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.command, 'run');
			assert.equal(result.result.response, 'A compact answer.');

			const output = JSON.parse(stdout.text);
			assert.equal(output.responseChars, 'A compact answer.'.length);
			assert.deepEqual(output.finishReasons, ['stop']);

			assert.equal(
				await readFile(join(cwd, 'run-output', 'prompt.md'), 'utf8'),
				'Summarize the repo.',
			);
			assert.equal(
				await readFile(join(cwd, 'run-output', 'response.md'), 'utf8'),
				'A compact answer.',
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'run-output', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.model, 'fake-local-model');
			assert.equal(summary.responseCount, 1);
			assert.equal(summary.promptChars, 'Summarize the repo.'.length);
			assert.deepEqual(summary.artifacts, {
				prompt: 'prompt.md',
				rawResponse: 'raw-response.json',
				response: 'response.md',
				summary: 'summary.json',
			});
			assert.equal(Object.hasOwn(summary, 'runDir'), false);

			const raw = JSON.parse(
				await readFile(join(cwd, 'run-output', 'raw-response.json'), 'utf8'),
			);
			assert.equal(raw.responses[0].id, 'chatcmpl_run');

			const chatRequest = server.recordings[1].requestBody;
			assert.equal(chatRequest.messages[0].content, 'Summarize the repo.');
			assert.equal(chatRequest.model, 'fake-local-model');
		} finally {
			await server.close();
		}
	});

	it('reads prompts from --prompt-file and stitches length continuations', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'length',
								message: {
									content: 'First half ',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_part_1',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'second half.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_part_2',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-run-file-'));
			await writeFile(join(cwd, 'prompt.md'), 'Continue this thought.', 'utf8');

			const result = await main(
				[
					'run',
					'--prompt-file',
					'prompt.md',
					'--base-url',
					server.baseUrl,
					'--out',
					'stitched-output',
					'--timeout-ms',
					'1000',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.response, 'First half second half.');
			assert.deepEqual(result.result.finishReasons, ['length', 'stop']);
			assert.equal(
				await readFile(join(cwd, 'stitched-output', 'response.md'), 'utf8'),
				'First half second half.',
			);

			const raw = JSON.parse(
				await readFile(
					join(cwd, 'stitched-output', 'raw-response.json'),
					'utf8',
				),
			);
			assert.deepEqual(
				raw.responses.map((response) => response.id),
				['chatcmpl_part_1', 'chatcmpl_part_2'],
			);

			const continuationRequest = server.recordings[2].requestBody;
			assert.equal(continuationRequest.messages[1].role, 'assistant');
			assert.equal(continuationRequest.messages[1].content, 'First half ');
			assert.equal(
				continuationRequest.messages[2].content,
				'Continue from exactly where you stopped.',
			);
		} finally {
			await server.close();
		}
	});

	it('rejects ambiguous prompt input', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-run-ambiguous-'));

		await assert.rejects(
			() =>
				main(['run', '-p', 'one', '--prompt-file', 'prompt.md'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/either/u,
		);
	});
});

function captureStream() {
	return {
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}
