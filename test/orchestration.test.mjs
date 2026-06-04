import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildWorkspaceContext } from '../src/context-packer.mjs';
import {
	runImplementerAgent,
	runPlannerAgent,
	runReviewerAgent,
	runSubagentStages,
	splitAgentDirectives,
} from '../src/orchestration.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('subagent stage orchestration', () => {
	it('routes agent-targeted directives', () => {
		const parsed = splitAgentDirectives(
			[
				'Add a greet function.',
				'planner: inspect src first',
				'implementer: use patches',
				'reviewer: run the security audit',
			].join('\n'),
		);

		assert.equal(parsed.basePrompt, 'Add a greet function.');
		assert.deepEqual(parsed.directives.planner, ['inspect src first']);
		assert.deepEqual(parsed.directives.implementer, ['use patches']);
		assert.deepEqual(parsed.directives.reviewer, ['run the security audit']);
	});

	it('runs planner with roster and returns a plan', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-planner-'));
		const server = await startFakeModelServer({
			responses: [chatText('1. Edit src/util.mjs\n2. Add tests')],
		});

		try {
			const context = await buildWorkspaceContext(cwd, { toolsMode: true });
			const result = await runPlannerAgent(
				cwd,
				join(runDir, 'planner'),
				'planner: focus on util\nAdd greet.',
				context,
				options(server),
			);

			assert.match(result.plan, /Edit src\/util\.mjs/u);
			const request = JSON.parse(
				await readFile(join(runDir, 'planner', 'request.json'), 'utf8'),
			);
			assert.match(request.messages[0].content, /Subagent Pipeline/u);
			assert.match(request.messages[0].content, /planner/u);
			assert.match(request.messages[1].content, /focus on util/u);
		} finally {
			await server.close();
		}
	});

	it('runs implementer and extracts a valid proposal', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-implementer-'));
		const server = await startFakeModelServer({
			responses: [
				chatText(
					JSON.stringify({
						status: 'OK',
						files: [
							{
								path: 'src/greet.mjs',
								content: 'export const greet = () => "hi";\n',
							},
						],
						messages: [{ level: 'info', content: 'implemented greet' }],
					}),
				),
			],
		});

		try {
			const context = await buildWorkspaceContext(cwd, { toolsMode: true });
			const result = await runImplementerAgent(
				cwd,
				join(runDir, 'implementer'),
				'Add greet.',
				'Create src/greet.mjs',
				context,
				options(server),
			);

			assert.equal(result.proposal.files[0].path, 'src/greet.mjs');
			const proposal = JSON.parse(
				await readFile(join(runDir, 'implementer', 'proposal.json'), 'utf8'),
			);
			assert.equal(proposal.messages[0].content, 'implemented greet');
			const request = JSON.parse(
				await readFile(join(runDir, 'implementer', 'request.json'), 'utf8'),
			);
			assert.doesNotMatch(
				request.messages[0].content,
				/Create src\/greet\.mjs/u,
			);
			assert.match(request.messages[1].content, /Create src\/greet\.mjs/u);
		} finally {
			await server.close();
		}
	});

	it('runs reviewer and returns pass issues and summary', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-reviewer-'));
		const server = await startFakeModelServer({
			responses: [
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Looks complete.',
					}),
				),
			],
		});

		try {
			const result = await runReviewerAgent(
				cwd,
				join(runDir, 'reviewer'),
				'reviewer: run tests after',
				'Create src/greet.mjs',
				{
					verification: null,
					writeResult: {
						applied: true,
						writes: [{ path: 'src/greet.mjs', status: 'create' }],
					},
				},
				options(server),
			);

			assert.equal(result.review.pass, true);
			const request = JSON.parse(
				await readFile(join(runDir, 'reviewer', 'request.json'), 'utf8'),
			);
			assert.match(request.messages[1].content, /run tests after/u);
			assert.doesNotMatch(
				request.messages[0].content,
				/Create src\/greet\.mjs/u,
			);
			assert.match(request.messages[1].content, /src\/greet\.mjs/u);
			assert.equal(
				request.tools.some((tool) => tool.function.name === 'run_command'),
				false,
			);
		} finally {
			await server.close();
		}
	});

	it('runs the full happy path and writes orchestration artifacts', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-full-'));
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create src/greet.mjs\n2. Review the proposal'),
				chatText(
					JSON.stringify({
						status: 'OK',
						files: [
							{
								path: 'src/greet.mjs',
								content: 'export const greet = () => "hi";\n',
							},
						],
						messages: [],
					}),
				),
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Complete.',
					}),
				),
			],
		});

		try {
			const result = await runSubagentStages(cwd, runDir, 'Add greet.', {
				...options(server),
				yes: false,
			});
			assert.equal(result.ok, true);
			assert.equal(result.writeResult.writes.length, 1);
			const summary = JSON.parse(
				await readFile(join(runDir, 'orchestration.json'), 'utf8'),
			);
			assert.equal(summary.agents.reviewer.pass, true);
			assert.match(summary.plan, /Create src\/greet\.mjs/u);
		} finally {
			await server.close();
		}
	});

	it('emits subagent progress callbacks', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-progress-'));
		const events = [];
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create src/greet.mjs'),
				chatText(
					JSON.stringify({
						files: [
							{
								content: 'export const greet = () => "hi";\n',
								path: 'src/greet.mjs',
							},
						],
						status: 'OK',
					}),
				),
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Complete.',
					}),
				),
			],
		});

		try {
			await runSubagentStages(cwd, runDir, 'Add greet.', {
				...options(server),
				onProgress: (event) => events.push(event),
				yes: false,
			});
			assert.deepEqual(
				events.map((event) => `${event.agent}:${event.event}`),
				[
					'planner:subagent_start',
					'planner:subagent_finish',
					'implementer:subagent_start',
					'implementer:subagent_finish',
					'reviewer:subagent_start',
					'reviewer:subagent_finish',
				],
			);
		} finally {
			await server.close();
		}
	});

	it('uses per-agent model overrides for subagent calls and artifacts', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-agent-models-'));
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create src/greet.mjs'),
				chatText(
					JSON.stringify({
						files: [
							{
								content: 'export const greet = () => "hi";\n',
								path: 'src/greet.mjs',
							},
						],
						status: 'OK',
					}),
				),
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Complete.',
					}),
				),
			],
		});

		try {
			const base = options(server);
			const result = await runSubagentStages(cwd, runDir, 'Add greet.', {
				...base,
				agentModels: {
					implementer: {
						...base,
						model: 'implementer-model',
						provider: 'lmstudio',
					},
					planner: { ...base, model: 'planner-model', provider: 'openrouter' },
					reviewer: { ...base, model: 'reviewer-model', provider: 'lmstudio' },
				},
				yes: false,
			});
			assert.deepEqual(
				server.recordings.map((recording) => recording.requestBody.model),
				['planner-model', 'implementer-model', 'reviewer-model'],
			);
			assert.equal(server.recordings[0].requestBody.response_format, undefined);
			assert.equal(
				server.recordings[1].requestBody.response_format.json_schema.name,
				'kodr_proposal',
			);
			assert.equal(
				server.recordings[2].requestBody.response_format.json_schema.name,
				'kodr_review',
			);
			assert.equal(result.orchestration.agents.planner.model, 'planner-model');
			assert.equal(result.orchestration.agents.planner.provider, 'openrouter');
			assert.equal(
				result.orchestration.agents.reviewer.model,
				'reviewer-model',
			);
		} finally {
			await server.close();
		}
	});

	it('runs deterministic verification and hands a compact result to the reviewer', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-verification-'));
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create test/greet.test.mjs'),
				chatText(
					JSON.stringify({
						files: [
							{
								content:
									'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => assert.equal(1, 1));\n',
								path: 'test/greet.test.mjs',
							},
						],
						status: 'OK',
					}),
				),
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Verified.',
					}),
				),
			],
		});

		try {
			const result = await runSubagentStages(cwd, runDir, 'Add a test.', {
				...options(server),
				testCommand: 'npm test',
				yes: true,
			});

			assert.equal(result.ok, true);
			assert.equal(result.tested, true);
			assert.equal(result.testResult.ok, true);
			assert.equal(result.verification.requestedCommand, 'npm test');
			assert.equal(result.verification.resolvedCommand, 'node --test');
			const reviewerRequest = JSON.parse(
				await readFile(
					join(runDir, 'subagents', 'reviewer', 'request.json'),
					'utf8',
				),
			);
			assert.match(reviewerRequest.messages[1].content, /node --test/u);
			assert.doesNotMatch(
				reviewerRequest.messages[1].content,
				/import test from/u,
			);
			assert.equal(
				reviewerRequest.tools.some(
					(tool) => tool.function.name === 'run_command',
				),
				false,
			);
			const tests = JSON.parse(
				await readFile(join(runDir, 'tests.json'), 'utf8'),
			);
			assert.equal(tests.resolvedCommand, 'node --test');
		} finally {
			await server.close();
		}
	});

	it('runs dependency installation before verification', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-install-'));
		const commands = [];
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create package.json'),
				chatText(
					JSON.stringify({
						files: [
							{
								content: '{"scripts":{"test":"node --test"},"type":"module"}\n',
								path: 'package.json',
							},
						],
						status: 'OK',
					}),
				),
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Verified.',
					}),
				),
			],
		});

		try {
			const result = await runSubagentStages(cwd, runDir, 'Add a package.', {
				...options(server),
				commandRunner: async (_cwd, parsed) => {
					commands.push(`${parsed.bin} ${parsed.args.join(' ')}`);
					return {
						exitCode: 0,
						stderr: '',
						stdout: 'ok',
						timedOut: false,
					};
				},
				installDependencies: true,
				testCommand: 'npm test',
				yes: true,
			});

			assert.deepEqual(commands, ['npm install', 'npm test']);
			assert.equal(result.installResult.ok, true);
			assert.equal(result.testResult.ok, true);
		} finally {
			await server.close();
		}
	});

	it('surfaces reviewer failure without throwing', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-review-fail-'));
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create src/greet.mjs'),
				chatText(
					JSON.stringify({
						status: 'OK',
						files: [
							{
								path: 'src/greet.mjs',
								content: 'export const greet = () => "hi";\n',
							},
						],
						messages: [],
					}),
				),
				chatText(
					JSON.stringify({
						pass: false,
						issues: ['Missing test coverage'],
						summary: 'Needs tests.',
					}),
				),
			],
		});
		const stderr = {
			text: '',
			write(chunk) {
				this.text += chunk;
			},
		};

		try {
			const result = await runSubagentStages(
				cwd,
				runDir,
				'Add greet.',
				{
					...options(server),
					yes: false,
				},
				{ stderr },
			);
			assert.equal(result.ok, false);
			assert.match(stderr.text, /Missing test coverage/u);
		} finally {
			await server.close();
		}
	});

	it('fails when the implementer does not emit a proposal', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-missing-proposal-'));
		const server = await startFakeModelServer({
			responses: [
				chatText('1. Create src/greet.mjs'),
				chatText('I changed it.'),
				chatText(
					JSON.stringify({
						pass: true,
						issues: [],
						summary: 'Looks fine.',
					}),
				),
			],
		});

		try {
			const result = await runSubagentStages(cwd, runDir, 'Add greet.', {
				...options(server),
				yes: false,
			});
			assert.equal(result.ok, false);
			assert.equal(result.writeError.name, 'ProposalMissingError');
		} finally {
			await server.close();
		}
	});

	it('treats malformed reviewer output as a failed review', async () => {
		const cwd = await makeWorkspace();
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-orch-review-bad-json-'));
		const server = await startFakeModelServer({
			responses: [chatText('not json')],
		});

		try {
			const result = await runReviewerAgent(
				cwd,
				join(runDir, 'reviewer'),
				'Add greet.',
				'Create src/greet.mjs',
				{
					verification: null,
					writeResult: {
						applied: false,
						writes: [
							{
								diff: '+export const greet = () => "hi";',
								path: 'src/greet.mjs',
								status: 'create',
							},
						],
					},
				},
				options(server),
			);
			assert.equal(result.review.pass, false);
			assert.match(result.review.issues[0], /valid review JSON/u);
		} finally {
			await server.close();
		}
	});
});

async function makeWorkspace() {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-orch-ws-'));
	await mkdir(join(cwd, 'src'), { recursive: true });
	await writeFile(join(cwd, 'src', 'util.mjs'), 'export const value = 1;\n');
	return cwd;
}

function options(server) {
	return {
		baseUrl: server.baseUrl,
		model: 'fake-local-model',
		provider: 'local',
		timeoutMs: 1000,
		maxTurns: 3,
		maxRetries: 0,
		maxTokens: '',
		maxCostUsd: '',
	};
}

function chatText(content) {
	return {
		body: {
			choices: [
				{
					message: { content, role: 'assistant' },
					finish_reason: 'stop',
				},
			],
			id: 'chatcmpl_fake',
			object: 'chat.completion',
		},
		method: 'POST',
		status: 200,
		url: '/v1/chat/completions',
	};
}
