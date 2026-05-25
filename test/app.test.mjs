import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { CliError, main, parseArgs, usage, VERSION } from '../src/app.mjs';

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
		const requests = [];
		const server = createServer(async (request, response) => {
			const body = await readRequestBody(request);
			requests.push({
				authorization: request.headers.authorization,
				body,
				method: request.method,
				url: request.url,
			});

			response.setHeader('content-type', 'application/json');

			if (request.method === 'GET' && request.url === '/v1/models') {
				response.end(
					JSON.stringify({
						data: [
							{
								id: 'fake-local-model',
								object: 'model',
							},
						],
						object: 'list',
					}),
				);
				return;
			}

			if (request.method === 'POST' && request.url === '/v1/chat/completions') {
				response.end(
					JSON.stringify({
						choices: [
							{
								message: {
									content: 'koder-probe-ok',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_fake',
						object: 'chat.completion',
					}),
				);
				return;
			}

			response.statusCode = 404;
			response.end(JSON.stringify({ error: 'not found' }));
		});

		await listen(server);
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-probe-'));
			const stdout = captureStream();
			const result = await main(
				[
					'probe',
					'--base-url',
					serverBaseUrl(server),
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
				requests.map((request) => `${request.method} ${request.url}`),
				['GET /v1/models', 'POST /v1/chat/completions'],
			);
			assert.equal(requests[0].authorization, 'Bearer secret-test-key');
			assert.equal(requests[1].authorization, 'Bearer secret-test-key');

			const chatRequest = JSON.parse(requests[1].body);
			assert.equal(chatRequest.model, 'fake-local-model');
			assert.equal(chatRequest.messages[0].role, 'user');

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
			await close(server);
		}
	});

	it('fails when the model server returns invalid JSON', async () => {
		const server = createServer((request, response) => {
			response.setHeader('content-type', 'application/json');
			response.end('not json');
		});

		await listen(server);
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-probe-bad-json-'));

			await assert.rejects(
				() =>
					main(
						[
							'probe',
							'--base-url',
							serverBaseUrl(server),
							'--timeout-ms',
							'1000',
						],
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
			await close(server);
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

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
}

function close(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function serverBaseUrl(server) {
	const address = server.address();
	return `http://${address.address}:${address.port}/v1`;
}

function readRequestBody(request) {
	return new Promise((resolve, reject) => {
		let body = '';

		request.setEncoding('utf8');
		request.on('data', (chunk) => {
			body += chunk;
		});
		request.on('end', () => {
			resolve(body);
		});
		request.on('error', reject);
	});
}
