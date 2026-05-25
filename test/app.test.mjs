import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CliError, main, parseArgs, usage, VERSION } from '../src/app.mjs';
import { startFakeModelServer } from './fake-model-server.mjs';

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
			'--api-key',
			'test-key',
			'--timeout-ms',
			'1000',
			'--json',
		]);

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.model, 'nvidia/nemotron-3-nano-omni');
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

function captureStream() {
	return {
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}
