import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
			'--test-cwd',
			'examples/todo-cli',
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
		assert.equal(options.testCwd, 'examples/todo-cli');
		assert.equal(options.apiKey, 'test-key');
		assert.equal(options.timeoutMs, 1000);
		assert.equal(options.json, true);
	});

	it('parses cycle review flags', () => {
		const options = parseArgs([
			'cycle-review',
			'--transcript-file',
			'chat.md',
			'--out',
			'cycle-run',
		]);

		assert.equal(options.command, 'cycle-review');
		assert.equal(options.transcriptFile, 'chat.md');
		assert.equal(options.out, 'cycle-run');
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
				context: 'context.md',
				prompt: 'prompt.md',
				rawResponse: 'raw-response.json',
				response: 'response.md',
				scratchpad: 'scratchpad.md',
				summary: 'summary.json',
				tasks: 'tasks.json',
				tests: 'tests.json',
				writes: 'writes.json',
			});
			assert.equal(Object.hasOwn(summary, 'runDir'), false);

			const raw = JSON.parse(
				await readFile(join(cwd, 'run-output', 'raw-response.json'), 'utf8'),
			);
			assert.equal(raw.responses[0].id, 'chatcmpl_run');

			const chatRequest = server.recordings[1].requestBody;
			assert.equal(chatRequest.messages[0].role, 'system');
			assert.match(chatRequest.messages[0].content, /You are Kodr/u);
			assert.equal(chatRequest.messages[1].content, 'Summarize the repo.');
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
			assert.equal(continuationRequest.messages[2].role, 'assistant');
			assert.equal(continuationRequest.messages[2].content, 'First half ');
			assert.equal(
				continuationRequest.messages[3].content,
				'Continue from exactly where you stopped.',
			);
		} finally {
			await server.close();
		}
	});

	it('can read streaming chat completions', async () => {
		const streamBody = [
			'data: {"id":"stream-1","choices":[{"delta":{"content":"streamed "},"finish_reason":null}]}',
			'',
			'data: {"id":"stream-1","choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}',
			'',
			'data: [DONE]',
			'',
		].join('\n');
		const server = await startFakeModelServer({
			responses: [
				{
					body: streamBody,
					headers: {
						'content-type': 'text/event-stream',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-run-stream-'));
			const result = await main(
				[
					'run',
					'-p',
					'Stream a response.',
					'--base-url',
					server.baseUrl,
					'--stream',
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

			assert.equal(result.result.response, 'streamed answer');
			assert.deepEqual(result.result.finishReasons, ['stop']);
			assert.equal(server.recordings[1].requestBody.stream, true);
		} finally {
			await server.close();
		}
	});

	it('writes failure artifacts when model completion fails', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						error: 'model unavailable',
					},
					method: 'POST',
					status: 500,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-run-model-fail-'));

			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'Build an example.',
							'--base-url',
							server.baseUrl,
							'--out',
							'failed-run',
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
				/Model run failed/u,
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'failed-run', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.equal(summary.artifacts.error, 'error.json');
			assert.match(summary.error.message, /HTTP 500/u);
			assert.equal(
				await readFile(join(cwd, 'failed-run', 'prompt.md'), 'utf8'),
				'Build an example.',
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

	it('rejects prompt-file paths outside the workspace', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'koder-run-prompt-escape-'));
		const cwd = join(parent, 'workspace');
		await mkdir(cwd, { recursive: true });
		await writeFile(join(parent, 'prompt.md'), 'outside', 'utf8');

		await assert.rejects(
			() =>
				main(['run', '--prompt-file', '../prompt.md'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Parent path segments/u,
		);
	});

	it('prints packed context without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-show-context-'));
			await writeFile(join(cwd, 'AGENTS.md'), 'Use local models.', 'utf8');
			await writeFile(join(cwd, 'a.txt'), 'alpha', 'utf8');
			const stdout = captureStream();

			const result = await main(
				['run', '--show-context', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.match(stdout.text, /## AGENTS\.md/u);
			assert.match(stdout.text, /Use local models/u);
			assert.match(stdout.text, /## a\.txt/u);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('prints deterministic context file paths without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-show-files-'));
			await writeFile(join(cwd, 'b.txt'), 'b', 'utf8');
			await writeFile(join(cwd, 'a.txt'), 'a', 'utf8');
			const stdout = captureStream();

			const result = await main(
				['run', '--show-files', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.deepEqual(stdout.text.trim().split('\n'), ['a.txt', 'b.txt']);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('prints discovered Markdown skills without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-show-skills-'));
			await mkdir(join(cwd, 'skills', 'edit'), { recursive: true });
			await writeFile(
				join(cwd, 'skills', 'edit', 'SKILL.md'),
				'---\nname: editor\ndescription: Edit files\n---\nUse patches.',
				'utf8',
			);
			const stdout = captureStream();

			const result = await main(
				['run', '--show-skills', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.match(stdout.text, /editor/u);
			assert.match(stdout.text, /skills\/edit\/SKILL\.md/u);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('loads requested Markdown skills into the system prompt', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-load-skill-'));
			await mkdir(join(cwd, 'skills', 'review'), { recursive: true });
			await writeFile(
				join(cwd, 'skills', 'review', 'SKILL.md'),
				'---\nname: reviewer\ndescription: Review code\n---\nAlways inspect tests.',
				'utf8',
			);

			await main(
				[
					'run',
					'-p',
					'Check the change.',
					'--skill',
					'reviewer',
					'--base-url',
					server.baseUrl,
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

			const chatRequest = server.recordings[1].requestBody;
			assert.match(
				chatRequest.messages[0].content,
				/Available Markdown skills/u,
			);
			assert.match(chatRequest.messages[0].content, /Loaded Markdown skills/u);
			assert.match(chatRequest.messages[0].content, /Always inspect tests/u);
		} finally {
			await server.close();
		}
	});

	it('dry-runs extracted file proposals by default', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'new readme',
								path: 'README.md',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-proposal-dry-'));
			await writeFile(join(cwd, 'README.md'), 'old readme', 'utf8');

			const result = await main(
				['run', '-p', 'Update README', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.proposalFound, true);
			assert.equal(result.result.applied, false);
			assert.equal(
				await readFile(join(cwd, 'README.md'), 'utf8'),
				'old readme',
			);

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.equal(writes.applied, false);
			assert.match(writes.writes[0].diff, /new readme/u);

			const tasks = JSON.parse(
				await readFile(join(result.result.runDir, 'tasks.json'), 'utf8'),
			);
			assert.equal(
				tasks.tasks.find((task) => task.id === 'edit-readme-md').status,
				'completed',
			);
			assert.equal(result.result.taskCounts.completed, 4);
		} finally {
			await server.close();
		}
	});

	it('loads memory scopes into run context and records scratchpad artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'ok\n',
								path: 'note.txt',
							},
						],
						scratchpad: 'Next run should keep the repair scoped to one file.',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-run-memory-'));
			await writeFile(join(cwd, 'KODR_MEMORY.md'), 'Prefer patches.\n', 'utf8');
			await mkdir(join(cwd, '.koder', 'memory'), { recursive: true });
			await writeFile(
				join(cwd, '.koder', 'memory', 'user.md'),
				'Keep examples small.\n',
				'utf8',
			);

			const result = await main(
				['run', '-p', 'Use memory.', '--base-url', server.baseUrl],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			const chatRequest = server.recordings[1].requestBody;
			assert.match(chatRequest.messages[0].content, /Project memory/u);
			assert.match(chatRequest.messages[0].content, /Prefer patches/u);
			assert.match(chatRequest.messages[0].content, /Private user memory/u);
			assert.match(chatRequest.messages[0].content, /Keep examples small/u);
			assert.equal(
				await readFile(join(result.result.runDir, 'scratchpad.md'), 'utf8'),
				'Next run should keep the repair scoped to one file.',
			);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.artifacts.scratchpad, 'scratchpad.md');
		} finally {
			await server.close();
		}
	});

	it('applies extracted proposals with --yes and records tests', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'export {};\n',
								path: 'created.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-proposal-apply-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create a module',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'node --check created.mjs',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(result.result.tested, true);
			assert.equal(
				await readFile(join(cwd, 'created.mjs'), 'utf8'),
				'export {};\n',
			);

			const tests = JSON.parse(
				await readFile(join(result.result.runDir, 'tests.json'), 'utf8'),
			);
			assert.equal(tests.ok, true);
		} finally {
			await server.close();
		}
	});

	it('applies extracted patch proposals with --yes', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						patches: [
							{
								path: 'README.md',
								replace: 'hello patched\n',
								search: 'hello\n',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-proposal-patch-'));
			await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

			const result = await main(
				['run', '-p', 'Patch README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.applied, true);
			assert.equal(
				await readFile(join(cwd, 'README.md'), 'utf8'),
				'hello patched\n',
			);
			assert.equal(result.result.writeResult.writes[0].status, 'patch');
			assert.equal(
				result.result.taskPlan.tasks.find(
					(task) => task.id === 'edit-readme-md',
				).status,
				'completed',
			);
		} finally {
			await server.close();
		}
	});

	it('records failed patch proposals as failed run artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						patches: [
							{
								path: 'README.md',
								replace: 'changed\n',
								search: 'missing\n',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-proposal-bad-patch-'));
			await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

			const result = await main(
				['run', '-p', 'Patch README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'hello\n');

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.match(summary.writeError.message, /found 0/u);

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.match(writes.error.message, /found 0/u);

			const tasks = JSON.parse(
				await readFile(join(result.result.runDir, 'tasks.json'), 'utf8'),
			);
			assert.equal(
				tasks.tasks.find((task) => task.id === 'edit-readme-md').status,
				'failed',
			);
		} finally {
			await server.close();
		}
	});

	it('records invalid proposals as failed run artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						patches: [
							{
								path: 'README.md',
								search: 'hello\n',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-proposal-invalid-'));
			await writeFile(join(cwd, 'README.md'), 'hello\n', 'utf8');

			const result = await main(
				['run', '-p', 'Patch README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'hello\n');

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.match(summary.proposalError.message, /Proposal patches/u);
			assert.equal(
				await readFile(join(result.result.runDir, 'response.md'), 'utf8'),
				JSON.stringify({
					patches: [
						{
							path: 'README.md',
							search: 'hello\n',
						},
					],
				}),
			);
		} finally {
			await server.close();
		}
	});

	it('runs verification from a jailed test cwd', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: '{"type":"module","scripts":{"test":"node --test"}}\n',
								path: 'example/package.json',
							},
							{
								content:
									"import assert from 'node:assert/strict';\nimport { test } from 'node:test';\n\ntest('subproject test', () => assert.equal(1, 1));\n",
								path: 'example/test/example.test.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-test-cwd-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create a subproject',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'npm test',
					'--test-cwd',
					'example',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.testResult.ok, true);
			assert.match(result.result.testResult.stdout, /node --test/u);
			assert.match(
				await readFile(join(cwd, 'example', '.koder', 'last-test.md'), 'utf8'),
				/node --test/u,
			);
		} finally {
			await server.close();
		}
	});

	it('marks the run failed when verification fails', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const broken = ;\n',
								path: 'example/bad.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-test-fails-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Create a failing subproject',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'node --check bad.mjs',
					'--test-cwd',
					'example',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, false);
			assert.equal(result.result.ok, false);
			assert.equal(result.result.testResult.ok, false);
			assert.match(stdout.text, /^Run failed/u);
		} finally {
			await server.close();
		}
	});

	it('rejects test cwd paths outside the workspace', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [] }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'koder-test-cwd-escape-'));

			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'No writes',
							'--base-url',
							server.baseUrl,
							'--yes',
							'--test',
							'npm test',
							'--test-cwd',
							'..',
						],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/Parent path segments/u,
			);
		} finally {
			await server.close();
		}
	});
});

describe('replay', () => {
	it('prints saved run artifacts as JSON', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-replay-cli-'));
		await mkdir(join(cwd, 'run'), { recursive: true });
		await writeFile(join(cwd, 'run', 'prompt.md'), 'prompt', 'utf8');
		await writeFile(join(cwd, 'run', 'response.md'), 'response', 'utf8');
		await writeFile(join(cwd, 'run', 'summary.json'), '{"ok":true}\n', 'utf8');
		await writeFile(
			join(cwd, 'run', 'raw-response.json'),
			'{"responses":[]}\n',
			'utf8',
		);
		const stdout = captureStream();

		const result = await main(['replay', 'run'], {
			cwd,
			env: {},
			stderr: captureStream(),
			stdout,
		});

		assert.equal(result.ok, true);
		assert.equal(JSON.parse(stdout.text).response, 'response');
	});

	it('rejects replay paths outside the workspace', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'koder-replay-escape-'));
		const cwd = join(parent, 'workspace');
		await mkdir(cwd, { recursive: true });

		await assert.rejects(
			() =>
				main(['replay', '../run'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Parent path segments/u,
		);
	});
});

describe('cycle-review', () => {
	it('runs the cycle review subagent and writes artifacts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-cycle-review-'));
		await writeFile(join(cwd, 'AGENTS.md'), '- Run tests.\n', 'utf8');
		await writeFile(
			join(cwd, 'chat.md'),
			'User: Make sure examples are Kodr samples before moving on.\n',
			'utf8',
		);
		const stdout = captureStream();

		const result = await main(
			[
				'cycle-review',
				'--transcript-file',
				'chat.md',
				'--out',
				'cycle-review-run',
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
		assert.equal(result.result.result.findings.length, 1);
		assert.match(stdout.text, /Kodr samples/u);
		assert.match(
			await readFile(
				join(
					cwd,
					'cycle-review-run',
					'subagents',
					'cycle-review',
					'result.json',
				),
				'utf8',
			),
			/Kodr samples/u,
		);

		const summary = JSON.parse(
			await readFile(join(cwd, 'cycle-review-run', 'summary.json'), 'utf8'),
		);
		assert.equal(
			summary.artifacts.subagentResult,
			'subagents/cycle-review/result.json',
		);
	});

	it('rejects missing transcript file', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-cycle-review-missing-'));

		await assert.rejects(
			() =>
				main(['cycle-review'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/requires --transcript-file/u,
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

function proposalResponse(value) {
	return {
		choices: [
			{
				finish_reason: 'stop',
				message: {
					content: JSON.stringify(value),
					role: 'assistant',
				},
			},
		],
		id: 'chatcmpl_proposal',
		object: 'chat.completion',
	};
}
