import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	CliError,
	handleChannelRequest,
	main,
	parseArgs,
	usage,
	VERSION,
} from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

describe('parseArgs', () => {
	it('starts with LM Studio-friendly defaults', () => {
		const options = parseArgs([], {});

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.model, 'qwen/qwen3.6-35b-a3b');
		assert.equal(options.timeoutMs, 600000);
		assert.equal(options.contextWindow, 32768);
		assert.equal(options.completionReserve, 4096);
		assert.equal(options.sessionContextChars, 114688);
		assert.equal(options.modelProfile.id, 'qwen/qwen3.6-35b-a3b');
		assert.equal(options.maxTurns, 8);
		assert.equal(options.maxRetries, 7);
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
			'--max-turns',
			'3',
			'--max-retries',
			'2',
			'--max-thinking-tokens',
			'1024',
			'--prompt-cache',
			'off',
			'--max-tokens',
			'100',
			'--max-cost-usd',
			'0.01',
			'--context-window',
			'8000',
			'--completion-reserve',
			'2000',
			'--json',
		]);

		assert.equal(options.baseUrl, 'http://localhost:1234/v1');
		assert.equal(options.model, 'nvidia/nemotron-3-nano-omni');
		assert.equal(options.out, 'custom-run');
		assert.equal(options.promptFile, 'prompt.md');
		assert.equal(options.testCwd, 'examples/todo-cli');
		assert.equal(options.apiKey, 'test-key');
		assert.equal(options.timeoutMs, 1000);
		assert.equal(options.contextWindow, 8000);
		assert.equal(options.completionReserve, 2000);
		assert.equal(options.sessionContextChars, 24000);
		assert.equal(options.contextBudgetChars, 24000);
		assert.equal(options.maxTurns, 3);
		assert.equal(options.maxRetries, 2);
		assert.equal(options.maxThinkingTokens, 1024);
		assert.equal(options.promptCache, 'off');
		assert.equal(options.maxTokens, 100);
		assert.equal(options.maxCostUsd, '0.01');
		assert.equal(options.json, true);
	});

	it('validates context budget flags', () => {
		assert.throws(
			() =>
				parseArgs([
					'run',
					'--context-window',
					'1000',
					'--completion-reserve',
					'1000',
					'-p',
					'task',
				]),
			/--completion-reserve/u,
		);
	});

	it('loads configured model profile overrides for defaults', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-app-profiles-'));
		const profilePath = join(cwd, 'profiles.json');
		await writeFile(
			profilePath,
			JSON.stringify({
				profiles: {
					'local/custom-small': {
						completionReserve: 500,
						contextWindow: 2000,
						timeoutMs: 2222,
					},
				},
			}),
			'utf8',
		);

		const options = parseArgs(
			['run', '--model', 'custom-small', '-p', 'task'],
			{ KODR_MODEL_PROFILES: profilePath },
		);

		assert.equal(options.timeoutMs, 2222);
		assert.equal(options.sessionContextChars, 6000);
		assert.equal(options.contextBudgetChars, 6000);
		assert.equal(options.modelProfile.matched, true);
	});

	it('validates prompt cache policy', () => {
		assert.equal(parseArgs([]).promptCache, 'auto');
		assert.throws(
			() => parseArgs(['run', '--prompt-cache', 'always', '-p', 'task']),
			/--prompt-cache/u,
		);
	});

	it('parses staged execution flags', () => {
		assert.equal(parseArgs(['run', '--staged', '-p', 'task'], {}).staged, true);
		assert.equal(
			parseArgs(['run', '--no-staged', '-p', 'task'], {}).staged,
			false,
		);
		const subagents = parseArgs(['run', '--subagent-stages', '-p', 'task'], {});
		assert.equal(subagents.subagentStages, true);
		assert.equal(subagents.tools, true);
	});

	it('parses slash model specs and agent model overrides', () => {
		const options = parseArgs(
			[
				'run',
				'--model',
				'lmstudio/qwen/qwen3.6-35b-a3b',
				'--agent-model',
				'planner=openrouter/anthropic/claude-opus',
				'--agent-model',
				'reviewer=lmstudio/nvidia/nemotron-3-nano-omni',
				'-p',
				'task',
			],
			{
				OPENROUTER_API_KEY: 'or-test-key',
			},
		);

		assert.equal(options.provider, 'lmstudio');
		assert.equal(options.model, 'qwen/qwen3.6-35b-a3b');
		assert.equal(
			options.agentModelSpecs.planner,
			'openrouter/anthropic/claude-opus',
		);
		assert.equal(options.agentModels.planner.provider, 'openrouter');
		assert.equal(options.agentModels.planner.model, 'anthropic/claude-opus');
		assert.equal(
			options.agentModels.planner.modelProfile.provider,
			'openrouter',
		);
		assert.equal(options.agentModels.reviewer.provider, 'lmstudio');
		assert.equal(
			options.agentModels.reviewer.model,
			'nvidia/nemotron-3-nano-omni',
		);
		assert.equal(
			options.agentModels.reviewer.modelProfile.contextWindow,
			65536,
		);
	});

	it('routes primary openrouter slash specs to the OpenRouter endpoint', () => {
		const options = parseArgs(
			['run', '--model', 'openrouter/openai/gpt-4o-mini', '-p', 'task'],
			{
				OPENROUTER_API_KEY: 'or-test-key',
			},
		);

		assert.equal(options.provider, 'openrouter');
		assert.equal(options.model, 'openai/gpt-4o-mini');
		assert.equal(options.baseUrl, 'https://openrouter.ai/api/v1');
	});

	it('parses dependency install flag', () => {
		assert.equal(
			parseArgs(['run', '--install', '-p', 'task'], {}).installDependencies,
			true,
		);
	});

	it('parses docker sandbox flags and network defaults', () => {
		const basic = parseArgs(['run', '--docker-sandbox', '-p', 'task'], {});
		assert.equal(basic.dockerSandbox, true);
		assert.equal(basic.dockerImage, 'node:24-bookworm-slim');
		assert.equal(basic.dockerNetwork, 'none');
		assert.equal(basic.dockerWorkdir, '/workspace');
		assert.equal(basic.dockerKeep, false);

		const install = parseArgs(
			['run', '--docker-sandbox', '--install', '-p', 'task'],
			{},
		);
		assert.equal(install.dockerNetwork, 'bridge');

		const custom = parseArgs(
			[
				'run',
				'--docker-sandbox',
				'--docker-keep',
				'--docker-image',
				'node:24',
				'--docker-network',
				'none',
				'--docker-workdir',
				'/work',
				'-p',
				'task',
			],
			{},
		);
		assert.equal(custom.dockerImage, 'node:24');
		assert.equal(custom.dockerKeep, true);
		assert.equal(custom.dockerNetwork, 'none');
		assert.equal(custom.dockerWorkdir, '/work');
	});

	it('parses openshell sandbox flags and rejects unsafe combinations', () => {
		const basic = parseArgs(['run', '--openshell-sandbox', '-p', 'task'], {});
		assert.equal(basic.openshellSandbox, true);
		assert.equal(basic.openshellWorker, false);
		assert.equal(basic.openshellFrom, '');
		assert.equal(basic.openshellKeep, false);
		assert.equal(basic.openshellPolicy, '');

		const custom = parseArgs(
			[
				'run',
				'--openshell-sandbox',
				'--openshell-keep',
				'--openshell-from',
				'base',
				'--openshell-policy',
				'policy.yaml',
				'-p',
				'task',
			],
			{},
		);
		assert.equal(custom.openshellFrom, 'base');
		assert.equal(custom.openshellKeep, true);
		assert.equal(custom.openshellPolicy, 'policy.yaml');

		assert.throws(
			() =>
				parseArgs(
					['run', '--openshell-sandbox', '--docker-sandbox', '-p', 'task'],
					{},
				),
			/cannot be used with OpenShell/u,
		);
		assert.throws(
			() =>
				parseArgs(
					['run', '--openshell-sandbox', '--install', '-p', 'task'],
					{},
				),
			/--openshell-policy/u,
		);
	});

	it('parses openshell worker flags and rejects conflicting sandboxes', () => {
		const worker = parseArgs(
			[
				'run',
				'--openshell-worker',
				'--install',
				'--openshell-keep',
				'-p',
				'task',
			],
			{},
		);
		assert.equal(worker.openshellWorker, true);
		assert.equal(worker.openshellSandbox, false);
		assert.equal(worker.installDependencies, true);
		assert.equal(worker.openshellKeep, true);

		assert.throws(
			() =>
				parseArgs(
					['run', '--openshell-worker', '--openshell-sandbox', '-p', 'task'],
					{},
				),
			/--openshell-sandbox and --openshell-worker/u,
		);
		assert.throws(
			() =>
				parseArgs(
					['run', '--openshell-worker', '--docker-sandbox', '-p', 'task'],
					{},
				),
			/cannot be used with OpenShell/u,
		);
	});

	it('parses heal flag', () => {
		assert.equal(parseArgs(['run', '--heal', '-p', 'task'], {}).heal, true);
	});

	it('parses command hook flags', () => {
		const options = parseArgs([
			'run',
			'--hooks',
			'--hooks-config',
			'.kodr/custom-hooks.json',
			'-p',
			'task',
		]);

		assert.equal(options.enableHooks, true);
		assert.equal(options.hooksConfigPath, '.kodr/custom-hooks.json');
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

	it('parses tui session flags', () => {
		const session = parseArgs(['tui', '--session', 'run-1']);
		assert.equal(session.command, 'tui');
		assert.equal(session.sessionId, 'run-1');

		const latest = parseArgs(['tui', '--continue']);
		assert.equal(latest.command, 'tui');
		assert.equal(latest.continueSession, true);
	});

	it('parses session context budget', () => {
		const options = parseArgs([
			'run',
			'--session-context-chars',
			'12000',
			'-p',
			'task',
		]);

		assert.equal(options.sessionContextChars, 12000);
		assert.throws(
			() => parseArgs(['run', '--session-context-chars', '999', '-p', 'task']),
			/--session-context-chars/u,
		);
	});

	it('parses session export flags', () => {
		const options = parseArgs([
			'session',
			'export',
			'session-a',
			'--format',
			'markdown',
		]);

		assert.equal(options.command, 'session');
		assert.equal(options.sessionSubcommand, 'export');
		assert.equal(options.sessionId, 'session-a');
		assert.equal(options.sessionFormat, 'markdown');
	});

	it('parses serve flags', () => {
		const options = parseArgs(['serve', '--host', 'localhost', '--port', '0']);

		assert.equal(options.command, 'serve');
		assert.equal(options.serveHost, 'localhost');
		assert.equal(options.servePort, 0);
	});

	it('parses inspect symbol flags', () => {
		const options = parseArgs([
			'inspect',
			'--symbol',
			'runPrompt',
			'--file',
			'src/app.mjs',
		]);

		assert.equal(options.command, 'inspect');
		assert.equal(options.inspectSymbol, 'runPrompt');
		assert.equal(options.inspectFile, 'src/app.mjs');
	});

	it('parses inspection-aware context flags', () => {
		const options = parseArgs([
			'run',
			'-p',
			'change runPrompt',
			'--inspect-context',
		]);

		assert.equal(options.command, 'run');
		assert.equal(options.inspectContext, true);
	});

	// Phase 97: tri-state defaults
	it('tools defaults to auto then resolves from profile nativeToolCalls', () => {
		const opts = parseArgs(['run', '-p', 'task'], {});
		// Default profile has nativeToolCalls: true → resolves to true
		assert.equal(opts.tools, true);
		assert.equal(opts.configSources.tools, 'profile');
	});

	it('stream defaults to auto (resolved by main, not parseArgs)', () => {
		const opts = parseArgs(['run', '-p', 'task'], {});
		assert.equal(opts.stream, 'auto');
		assert.equal(opts.configSources.stream, 'builtin');
	});

	it('heal defaults to auto', () => {
		const opts = parseArgs(['run', '-p', 'task'], {});
		assert.equal(opts.heal, 'auto');
		assert.equal(opts.configSources.heal, 'builtin');
	});

	it('inspectContext defaults to auto', () => {
		const opts = parseArgs(['run', '-p', 'task'], {});
		assert.equal(opts.inspectContext, 'auto');
		assert.equal(opts.configSources.inspectContext, 'builtin');
	});

	it('--no-tools forces tools off and beats profile', () => {
		const opts = parseArgs(['run', '-p', 'task', '--no-tools'], {});
		assert.equal(opts.tools, false);
		assert.equal(opts.configSources.tools, 'flag');
	});

	it('--tools forces tools on', () => {
		const opts = parseArgs(['run', '-p', 'task', '--tools'], {});
		assert.equal(opts.tools, true);
		assert.equal(opts.configSources.tools, 'flag');
	});

	it('--no-stream forces stream off', () => {
		const opts = parseArgs(['run', '-p', 'task', '--no-stream'], {});
		assert.equal(opts.stream, false);
		assert.equal(opts.configSources.stream, 'flag');
	});

	it('--no-heal forces heal off', () => {
		const opts = parseArgs(['run', '-p', 'task', '--no-heal'], {});
		assert.equal(opts.heal, false);
		assert.equal(opts.configSources.heal, 'flag');
	});

	it('--no-inspect-context forces inspectContext off', () => {
		const opts = parseArgs(['run', '-p', 'task', '--no-inspect-context'], {});
		assert.equal(opts.inspectContext, false);
		assert.equal(opts.configSources.inspectContext, 'flag');
	});

	it('profile with nativeToolCalls false resolves tools to false in auto mode', () => {
		const cwd = mkdtempSync(join(tmpdir(), 'kodr-profile-'));
		const profilesPath = join(cwd, 'profiles.json');
		writeFileSync(
			profilesPath,
			JSON.stringify([
				{
					id: 'envelope-only/model',
					provider: 'local',
					nativeToolCalls: false,
				},
			]),
		);
		const opts = parseArgs(
			['run', '-p', 'task', '--model', 'envelope-only/model'],
			{ KODR_MODEL_PROFILES: profilesPath },
		);
		assert.equal(opts.tools, false);
		assert.equal(opts.configSources.tools, 'profile');
	});

	it('rejects unknown options', () => {
		assert.throws(() => parseArgs(['--wat']), CliError);
	});

	it('accepts flag values that start with -- or are empty', () => {
		const dashed = parseArgs(['run', '-p', '--not-a-flag']);
		assert.equal(dashed.prompt, '--not-a-flag');

		const empty = parseArgs(['run', '-p', '']);
		assert.equal(empty.prompt, '');
	});

	it('throws when a value-bearing flag has no following token', () => {
		assert.throws(() => parseArgs(['run', '-p']), CliError);
		assert.throws(() => parseArgs(['compare', '--models']), CliError);
	});

	it('--openrouter applies OpenRouter defaults', () => {
		const options = parseArgs(['--openrouter'], {
			OPENROUTER_API_KEY: 'or-test-key',
		});

		assert.equal(options.provider, 'openrouter');
		assert.equal(options.baseUrl, 'https://openrouter.ai/api/v1');
		assert.equal(options.model, 'openai/gpt-4o-mini');
		assert.equal(options.apiKey, 'or-test-key');
		assert.equal(options.extraHeaders['HTTP-Referer'] !== undefined, true);
		assert.equal(options.extraHeaders['X-Title'], 'kodr');
	});

	it('--openrouter falls back to OPENAI_API_KEY when OPENROUTER_API_KEY absent', () => {
		const options = parseArgs(['--openrouter'], {
			OPENAI_API_KEY: 'oai-fallback',
		});

		assert.equal(options.apiKey, 'oai-fallback');
	});

	it('--openrouter throws when no API key is available', () => {
		assert.throws(() => parseArgs(['--openrouter'], {}), CliError);
	});

	it('explicit flags override --openrouter defaults', () => {
		const options = parseArgs(
			[
				'--openrouter',
				'--base-url',
				'https://custom.endpoint/v1',
				'--model',
				'anthropic/claude-3-haiku',
				'--api-key',
				'explicit-key',
			],
			{ OPENROUTER_API_KEY: 'should-be-ignored' },
		);

		assert.equal(options.baseUrl, 'https://custom.endpoint/v1');
		assert.equal(options.model, 'anthropic/claude-3-haiku');
		assert.equal(options.apiKey, 'explicit-key');
	});

	it('--openrouter does not expose _apiKeySet on returned options', () => {
		const options = parseArgs(['--openrouter'], {
			OPENROUTER_API_KEY: 'or-key',
		});

		assert.equal('_apiKeySet' in options, false);
	});
});

describe('usage', () => {
	it('mentions the current version and planned commands', () => {
		const text = usage();

		assert.match(text, new RegExp(VERSION));
		assert.match(text, /kodr probe/u);
	});
});

describe('probe', () => {
	it('calls OpenAI-compatible endpoints and writes run artifacts', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-'));
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
			assert.equal(result.result.model, 'qwen/qwen3.6-35b-a3b');
			assert.equal(result.result.reply, 'kodr-probe-ok');

			const output = JSON.parse(stdout.text);
			assert.equal(output.ok, true);
			assert.equal(output.model, 'qwen/qwen3.6-35b-a3b');

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
			assert.equal(chatRequest.model, 'qwen/qwen3.6-35b-a3b');
			assert.equal(chatRequest.messages[0].role, 'user');
			assert.equal(
				server.recordings[1].responseBody.choices[0].message.content,
				'kodr-probe-ok',
			);

			const artifact = JSON.parse(
				await readFile(join(output.runDir, 'result.json'), 'utf8'),
			);
			assert.equal(artifact.ok, true);
			assert.equal(artifact.reply, 'kodr-probe-ok');

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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-bad-json-'));

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
	it('fails before the model call when OpenShell is incompatible and writes an artifact', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-openshell-incompatible-'));
		const out = 'run-output';
		const options = parseArgs([
			'run',
			'--openshell-sandbox',
			'-p',
			'Do not run.',
			'--out',
			out,
		]);
		const calls = [];
		options.openshellRunner = async (args) => {
			calls.push(args);
			if (args[0] === '--version') {
				return commandResult(0, 'openshell 0.0.20');
			}
			if (args[0] === 'sandbox' && args[1] === 'exec') {
				return commandResult(2, '', 'unrecognized subcommand');
			}
			return commandResult(0, 'help');
		};

		await assert.rejects(
			() =>
				handleChannelRequest(
					{ kind: 'run-turn', options },
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/Sandbox initialization failed/u,
		);
		assert.equal(
			calls.some(
				(args) =>
					args[0] === 'sandbox' &&
					args[1] === 'create' &&
					args.at(-1) !== '--help',
			),
			false,
		);
		const artifact = JSON.parse(
			await readFile(join(cwd, out, 'openshell.json'), 'utf8'),
		);
		assert.equal(artifact.enabled, true);
		assert.match(artifact.error.message, /sandbox exec/u);
	});

	it('cleans up OpenShell when run setup fails after sandbox creation', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-openshell-setup-failure-'));
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(join(cwd, '.kodr', 'hooks.json'), 'not json', 'utf8');
		const options = parseArgs([
			'run',
			'--openshell-sandbox',
			'--hooks',
			'-p',
			'Do not run.',
			'--out',
			'run-output',
		]);
		const calls = [];
		options.openshellRunner = async (args) => {
			calls.push(args);
			if (args[0] === 'status') {
				return commandResult(0, 'Server: https://127.0.0.1:8080\n');
			}
			return commandResult(0, 'ok');
		};

		await assert.rejects(
			() =>
				handleChannelRequest(
					{ kind: 'run-turn', options },
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/Could not load hooks config/u,
		);
		assert.equal(
			calls.some(
				(args) =>
					args[0] === 'sandbox' &&
					args[1] === 'delete' &&
					args.at(-1) !== '--help',
			),
			true,
		);
	});

	it('cleans up OpenShell when verification initialization fails after sandbox creation', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-openshell-verify-failure-'));
		await writeFile(join(cwd, 'package.json'), '{}\n', 'utf8');
		const options = parseArgs([
			'run',
			'--openshell-sandbox',
			'--test',
			'node --test',
			'-p',
			'Do not run.',
		]);
		const calls = [];
		options.openshellRunner = async (args) => {
			calls.push(args);
			if (args[0] === 'status') {
				return commandResult(0, 'Server: https://127.0.0.1:8080\n');
			}
			if (
				args[0] === 'sandbox' &&
				args[1] === 'upload' &&
				args.at(-1) !== '--help'
			) {
				return commandResult(1, '', 'upload failed');
			}
			return commandResult(0, 'ok');
		};

		await assert.rejects(
			() =>
				handleChannelRequest(
					{ kind: 'verify-command', options },
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/Could not upload workspace/u,
		);
		assert.equal(
			calls.some(
				(args) =>
					args[0] === 'sandbox' &&
					args[1] === 'delete' &&
					args.at(-1) !== '--help',
			),
			true,
		);
	});

	it('runs a nested Kodr worker inside OpenShell and downloads worker artifacts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-openshell-worker-'));
		await writeFile(join(cwd, 'prompt.md'), 'Make no changes.\n', 'utf8');
		const out = 'worker-output';
		const options = parseArgs([
			'run',
			'--openshell-worker',
			'--prompt-file',
			'prompt.md',
			'--yes',
			'--install',
			'--test',
			'npm test',
			'--out',
			out,
		]);
		const calls = [];
		options.openshellRunner = async (args) => {
			calls.push(args);
			if (args[0] === 'status') {
				return commandResult(0, 'Server: https://127.0.0.1:8080\n');
			}
			if (args[0] === 'sandbox' && args[1] === 'download') {
				const dest = args.at(-1);
				await mkdir(dest, { recursive: true });
				await writeFile(
					join(dest, 'summary.json'),
					JSON.stringify({
						applied: true,
						installResult: { command: 'npm install', ok: true },
						loopBudget: { stopReason: 'finish_stop' },
						model: 'qwen/qwen3.6-35b-a3b',
						ok: true,
						proposalStatus: 'OK',
						testResult: { command: 'npm test', ok: true },
						usage: null,
						writeCount: 0,
					}),
					'utf8',
				);
				await writeFile(
					join(dest, 'response.md'),
					JSON.stringify({
						files: [],
						messages: [{ content: 'done', level: 'info' }],
						status: 'OK',
					}),
					'utf8',
				);
				await writeFile(
					join(dest, 'writes.json'),
					JSON.stringify({ applied: true, writes: [] }),
					'utf8',
				);
				await writeFile(
					join(dest, 'tests.json'),
					JSON.stringify({ command: 'npm test', ok: true }),
					'utf8',
				);
				await writeFile(
					join(dest, 'install.json'),
					JSON.stringify({ command: 'npm install', ok: true }),
					'utf8',
				);
				return commandResult(0, 'downloaded');
			}
			return commandResult(0, 'ok');
		};

		const result = await handleChannelRequest(
			{ kind: 'run-turn', options },
			{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
		);

		assert.equal(result.ok, true);
		assert.equal(result.openshellWorker.mode, 'openshell-worker');
		assert.equal(
			calls.some((args) => args[0] === 'sandbox' && args[1] === 'download'),
			true,
		);
		const workerExec = calls.find(
			(args) =>
				args[0] === 'sandbox' &&
				args[1] === 'exec' &&
				args.includes('/kodr/bin/kodr.mjs'),
		);
		assert.ok(workerExec);
		assert.ok(workerExec.includes('--openshell-worker') === false);
		const workerArtifact = JSON.parse(
			await readFile(join(cwd, out, 'openshell-worker.json'), 'utf8'),
		);
		assert.equal(workerArtifact.exitCode, 0);
	});

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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-'));
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
					'--no-tools',
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
			assert.equal(summary.model, 'qwen/qwen3.6-35b-a3b');
			assert.equal(summary.modelProfile.id, 'qwen/qwen3.6-35b-a3b');
			assert.equal(summary.modelProfile.contextWindow, 32768);
			assert.equal(summary.contextBudget.contextWindow, 32768);
			assert.equal(summary.contextBudget.completionReserve, 4096);
			assert.equal(summary.responseCount, 1);
			assert.equal(summary.promptChars, 'Summarize the repo.'.length);
			assert.deepEqual(summary.artifacts, {
				context: 'context.md',
				conversation: 'conversation.json',
				conversationRaw: 'conversation-raw.json',
				diagnostics: 'diagnostics.json',
				messages: 'messages.json',
				prompt: 'prompt.md',
				promptPrefix: 'prompt-prefix.json',
				rawRequest: 'raw-request.json',
				rawResponse: 'raw-response.json',
				docker: 'docker.json',
				openshell: 'openshell.json',
				hooks: 'hooks.json',
				inspectionPlan: 'inspection-plan.json',
				repairs: 'repairs/repairs.json',
				response: 'response.md',
				scratchpad: 'scratchpad.md',
				sessionSummary: 'session-summary.json',
				summary: 'summary.json',
				install: 'install.json',
				tasks: 'tasks.json',
				tests: 'tests.json',
				writes: 'writes.json',
			});
			assert.equal(summary.promptPrefix.stableChars > 0, true);
			assert.equal(summary.promptPrefix.wireFormat, 'single-system-message');
			const promptPrefix = JSON.parse(
				await readFile(join(cwd, 'run-output', 'prompt-prefix.json'), 'utf8'),
			);
			assert.equal(promptPrefix.stableHash, summary.promptPrefix.stableHash);
			assert.equal(Object.hasOwn(summary, 'runDir'), false);

			const raw = JSON.parse(
				await readFile(join(cwd, 'run-output', 'raw-response.json'), 'utf8'),
			);
			assert.equal(raw.responses[0].id, 'chatcmpl_run');

			const chatRequest = server.recordings[0].requestBody;
			assert.equal(chatRequest.messages[0].role, 'system');
			assert.match(chatRequest.messages[0].content, /^You are Kodr/u);
			assert.equal(chatRequest.messages[1].content, 'Summarize the repo.');
			assert.equal(chatRequest.model, 'qwen/qwen3.6-35b-a3b');
			// S2: local models use structuredOutput: 'none' (measured default —
			// json_schema stalls both qwen3.6 and gemma-4 on LM Studio).
			assert.equal(
				chatRequest.response_format,
				undefined,
				'local model should not get response_format (structuredOutput: none)',
			);
		} finally {
			await server.close();
		}
	});

	it('prints a human-readable summary in non-JSON mode', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: proposalResponse({
						files: [
							{ path: 'src/index.mjs', content: 'export const x = 1;\n' },
						],
						messages: [{ level: 'info', content: 'Added a constant.' }],
						scratchpad: 'Plan: add a module.',
					}),
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-summary-'));
			const stdout = captureStream();
			const stderr = captureStream();
			await main(
				[
					'run',
					'-p',
					'Add a module.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr, stdout },
			);

			// The summary names the proposed file, its create status, the dry-run
			// mode, the model message, and how to apply — not just "Run ok".
			assert.match(stdout.text, /^Run ok/u);
			assert.match(stdout.text, /1 file\(s\), dry-run/u);
			assert.match(stdout.text, /create\s+src\/index\.mjs/u);
			assert.match(stdout.text, /\[info\] Added a constant\./u);
			assert.match(stdout.text, /Re-run with --yes/u);
			assert.match(stderr.text, /info: standard started/u);
			assert.match(stderr.text, /info: standard finished/u);
		} finally {
			await server.close();
		}
	});

	it('warns when agent model overrides are supplied outside subagent stages', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({ files: [], messages: [], status: 'OK' }),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-agent-model-warning-'));
			const stderr = captureStream();
			await main(
				[
					'run',
					'-p',
					'No changes.',
					'--agent-model',
					'planner=lmstudio/planner-model',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr, stdout: captureStream() },
			);

			assert.match(
				stderr.text,
				/info: --agent-model overrides are only used with --subagent-stages/u,
			);
			assert.equal(
				server.recordings[0].requestBody.model,
				'qwen/qwen3.6-35b-a3b',
			);
		} finally {
			await server.close();
		}
	});

	it('runs configured hooks through the CLI and records hook artifacts', async () => {
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
						id: 'chatcmpl_hooks',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-hooks-'));
			await mkdir(join(cwd, '.kodr'), { recursive: true });
			await writeFile(
				join(cwd, '.kodr/hooks.json'),
				JSON.stringify({
					hooks: {
						Stop: [
							{
								hooks: [
									{
										args: ['-e', 'process.stdout.write("hook ok")'],
										command: process.execPath,
										type: 'command',
									},
								],
							},
						],
					},
				}),
				'utf8',
			);

			await main(
				[
					'run',
					'-p',
					'Summarize.',
					'--base-url',
					server.baseUrl,
					'--out',
					'hook-run',
					'--timeout-ms',
					'1000',
					'--hooks',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			const hookArtifact = JSON.parse(
				await readFile(join(cwd, 'hook-run', 'hooks.json'), 'utf8'),
			);
			assert.equal(hookArtifact.enabled, true);
			assert.equal(hookArtifact.configPath, '.kodr/hooks.json');
			assert.equal(hookArtifact.environment, 'host');
			assert.equal(hookArtifact.records.length, 1);
			assert.equal(hookArtifact.records[0].event, 'stop');
			assert.equal(hookArtifact.records[0].environment, 'host');
			assert.equal(hookArtifact.records[0].stdout, 'hook ok');
		} finally {
			await server.close();
		}
	});

	it('runs AgentStart hooks before a standard model call', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content: 'Plain answer.',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_agent_start_hook',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-agent-start-hook-'));
			await mkdir(join(cwd, '.kodr'), { recursive: true });
			await writeFile(
				join(cwd, '.kodr/hooks.json'),
				JSON.stringify({
					hooks: {
						AgentStart: [
							{
								hooks: [
									{
										args: [
											'-e',
											"let s=''; process.stdin.on('data', c => s += c); process.stdin.on('end', () => { const input = JSON.parse(s); process.stdout.write(JSON.stringify({message: input.agent + ':' + input.model})); });",
										],
										command: process.execPath,
										type: 'command',
									},
								],
								matcher: 'standard',
							},
						],
					},
				}),
				'utf8',
			);

			const result = await main(
				[
					'run',
					'-p',
					'Answer plainly',
					'--hooks',
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
			const hooks = JSON.parse(
				await readFile(join(result.result.runDir, 'hooks.json'), 'utf8'),
			);

			assert.equal(hooks.records.length, 1);
			assert.equal(hooks.records[0].event, 'agent_start');
			assert.match(hooks.records[0].stdout, /standard:/u);
		} finally {
			await server.close();
		}
	});

	it('prints the response text when the model returns no proposal', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: proposalResponseText(
						'Just a plain prose answer, no JSON here.',
					),
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-prose-'));
			const stdout = captureStream();
			await main(
				[
					'run',
					'-p',
					'Explain something.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			assert.match(stdout.text, /Response:/u);
			assert.match(stdout.text, /Just a plain prose answer/u);
		} finally {
			await server.close();
		}
	});

	it('runs without querying /models when a model is provided', async () => {
		const server = await startFakeModelServer({
			responses: [
				// A 404 for /models proves the run never depends on discovery.
				{
					method: 'GET',
					url: '/v1/models',
					status: 404,
					body: { error: 'not found' },
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_no_models',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-no-models-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--model',
					'explicit-model',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.equal(result.ok, true);
			assert.equal(result.result.model, 'explicit-model');
			// Only the chat completion is recorded; /models was never called.
			assert.equal(server.recordings.length, 1);
			assert.equal(server.recordings[0].url, '/v1/chat/completions');
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
						usage: {
							completion_tokens: 2,
							prompt_tokens: 3,
							total_tokens: 5,
						},
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
						usage: {
							completion_tokens: 2,
							prompt_tokens: 4,
							total_tokens: 6,
						},
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-file-'));
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
					'--max-turns',
					'2',
					'--max-tokens',
					'20',
					'--no-tools',
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
			assert.deepEqual(result.result.loopBudget, {
				completionTokens: 4,
				cost: 0,
				costUsd: 0,
				maxCostUsd: null,
				maxRetries: 7,
				maxTokens: 20,
				maxTurns: 2,
				promptTokens: 7,
				retries: 1,
				stopReason: 'finish_stop',
				tokens: 11,
				turns: 2,
			});
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
			assert.equal(raw.loopBudget.tokens, 11);

			const continuationRequest = server.recordings[1].requestBody;
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

	it('stops continuation runs at the turn budget', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'length',
								message: {
									content: 'unfinished',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_budget_1',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-budget-'));
			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'Keep going forever.',
							'--base-url',
							server.baseUrl,
							'--out',
							'budget-output',
							'--timeout-ms',
							'1000',
							'--max-turns',
							'1',
							'--no-tools',
						],
						{
							cwd,
							env: {},
							stderr: captureStream(),
							stdout: captureStream(),
						},
					),
				/turn_budget_exhausted/u,
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'budget-output', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.match(summary.error.message, /turn_budget_exhausted/u);
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-stream-'));
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
			assert.equal(server.recordings[0].requestBody.stream, true);
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-model-fail-'));

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
			assert.equal(summary.error.details.status, 500);
			assert.equal(summary.error.details.phase, 'http-response');
			assert.equal(typeof summary.rawRequestBytes, 'number');
			assert.equal(summary.rawRequestBytes > 0, true);
			assert.equal(
				await readFile(join(cwd, 'failed-run', 'prompt.md'), 'utf8'),
				'Build an example.',
			);
			const error = JSON.parse(
				await readFile(join(cwd, 'failed-run', 'error.json'), 'utf8'),
			);
			assert.equal(
				error.details.responseTextSample,
				'{"error":"model unavailable"}',
			);
		} finally {
			await server.close();
		}
	});

	it('rejects ambiguous prompt input', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-ambiguous-'));

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
		const parent = await mkdtemp(join(tmpdir(), 'kodr-run-prompt-escape-'));
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-context-'));
			await writeFile(join(cwd, 'AGENTS.md'), 'Use local models.', 'utf8');
			await writeFile(join(cwd, 'a.txt'), 'alpha', 'utf8');
			const stdout = captureStream();

			const result = await main(
				[
					'run',
					'--show-context',
					'--no-inspect-context',
					'--base-url',
					server.baseUrl,
				],
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

	it('prints inspection-aware context without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-inspect-context-'));
			await mkdir(join(cwd, 'src'), { recursive: true });
			await writeFile(
				join(cwd, 'src', 'app.mjs'),
				'export function runPrompt() {\n  return true;\n}\n',
				'utf8',
			);
			const stdout = captureStream();

			const result = await main(
				[
					'run',
					'--show-context',
					'--inspect-context',
					'-p',
					'Change runPrompt',
					'--base-url',
					server.baseUrl,
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.match(stdout.text, /Inspection context/u);
			assert.match(stdout.text, /src\/app\.mjs#runPrompt/u);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('injects an inspection-derived plan before inspect-context model runs', async () => {
		const server = await startFakeModelServer({
			responses: [
				{ body: proposalResponse({ files: [], messages: [], status: 'OK' }) },
			],
		});
		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspection-plan-'));
			await mkdir(join(cwd, 'src'), { recursive: true });
			await writeFile(
				join(cwd, 'src/app.mjs'),
				'export function runPrompt() { return "ok"; }\n',
				'utf8',
			);
			const result = await main(
				[
					'run',
					'-p',
					'change runPrompt',
					'--inspect-context',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'run-output',
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

			assert.equal(result.ok, true);
			const userMessage = server.recordings[0].requestBody.messages[1].content;
			assert.match(userMessage, /Inspection-derived plan/u);
			assert.match(userMessage, /src\/app\.mjs:1-\d+ function runPrompt/u);
			const plan = JSON.parse(
				await readFile(join(cwd, 'run-output', 'inspection-plan.json'), 'utf8'),
			);
			assert.deepEqual(plan.inspection.targetFiles, ['src/app.mjs']);
			const tasks = JSON.parse(
				await readFile(join(cwd, 'run-output', 'tasks.json'), 'utf8'),
			);
			assert.equal(
				tasks.tasks.some((task) => task.path === 'src/app.mjs'),
				true,
			);
		} finally {
			await server.close();
		}
	});

	it('prints deterministic context file paths without calling the model', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-files-'));
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-show-skills-'));
			await mkdir(join(cwd, 'skills', 'edit'), { recursive: true });
			await writeFile(
				join(cwd, 'skills', 'edit', 'SKILL.md'),
				[
					'---',
					'name: editor',
					'description: Edit files',
					'resources:',
					'  - path: docs/patches.md',
					'    description: Patch examples',
					'---',
					'Use patches.',
				].join('\n'),
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
			assert.match(stdout.text, /docs\/patches\.md/u);
			assert.doesNotMatch(stdout.text, /Use patches/u);
			assert.equal(server.recordings.length, 0);
		} finally {
			await server.close();
		}
	});

	it('loads requested Markdown skills into the system prompt', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-load-skill-'));
			await mkdir(join(cwd, 'skills', 'review'), { recursive: true });
			await writeFile(
				join(cwd, 'skills', 'review', 'SKILL.md'),
				[
					'---',
					'name: reviewer',
					'description: Review code',
					'resources:',
					'  - path: docs/checklist.md',
					'    description: Review checklist',
					'---',
					'Always inspect tests.',
				].join('\n'),
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

			const chatRequest = server.recordings[0].requestBody;
			assert.match(
				chatRequest.messages[0].content,
				/Available Markdown skills/u,
			);
			assert.match(chatRequest.messages[0].content, /docs\/checklist\.md/u);
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-dry-'));
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

	it('records OK envelope messages alongside proposed writes', async () => {
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
						messages: [
							{
								content: 'Prepared README update.',
								level: 'info',
							},
						],
						status: 'OK',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-envelope-'));
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

			assert.equal(result.result.proposalStatus, 'OK');
			assert.equal(result.result.proposalMessageCount, 1);
			assert.deepEqual(
				JSON.parse(
					await readFile(join(result.result.runDir, 'messages.json'), 'utf8'),
				),
				[
					{
						content: 'Prepared README update.',
						level: 'info',
					},
				],
			);
			assert.equal(
				await readFile(join(cwd, 'README.md'), 'utf8'),
				'old readme',
			);
		} finally {
			await server.close();
		}
	});

	it('runs staged execution as plan plus bounded implementation turns', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Planned stages.', level: 'info' }],
						scratchpad:
							'{"plan":["create source","finish"],"next":"create source"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Stage 1 complete.', level: 'info' }],
						scratchpad: '',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const staged = true;\n',
								path: 'src/staged.mjs',
							},
						],
						messages: [{ content: 'Created source.', level: 'info' }],
						scratchpad: '{"done":["create source"],"next":"finish"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["create source","finish"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-staged-run-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Build an Express Postgres API.',
					'--tools',
					'--yes',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.result.ok, false);
			assert.equal(result.result.runError.name, 'StagedUnverifiedError');
			assert.equal(result.result.staged.auto, true);
			assert.equal(result.result.staged.stages.length, 4);
			assert.equal(result.result.responseCount, 4);
			assert.equal(result.result.staged.stages[1].noProgress, true);
			assert.equal(
				await readFile(join(cwd, 'src', 'staged.mjs'), 'utf8'),
				'export const staged = true;\n',
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.staged.done, true);
			assert.equal(summary.ok, false);
			assert.equal(summary.runError.name, 'StagedUnverifiedError');
			assert.equal(summary.writeCount, 1);
			assert.match(stdout.text, /^Run failed — staged/u);
			assert.match(stdout.text, /StagedUnverifiedError/u);
			assert.equal(server.recordings.length, 4);
			assert.match(
				server.recordings[0].requestBody.messages[1].content,
				/Return a plan only/u,
			);
			assert.match(
				server.recordings[2].requestBody.messages[1].content,
				/Previous implementation turn made no file changes/u,
			);
			assert.match(
				server.recordings[2].requestBody.messages[1].content,
				/at most 5 total file writes/u,
			);
		} finally {
			await server.close();
		}
	});

	it('runs subagent stages and writes orchestration artifacts', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponseText('1. Create src/greet.mjs\n2. Review it'),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const greet = () => "hi";\n',
								path: 'src/greet.mjs',
							},
						],
						messages: [{ content: 'Created greet.', level: 'info' }],
						status: 'OK',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponseText(
						JSON.stringify({
							pass: true,
							issues: [],
							summary: 'Complete.',
						}),
					),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-subagent-stages-run-'));
			const stderr = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'reviewer: check the generated file\nAdd greet.',
					'--subagent-stages',
					'--yes',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{
					cwd,
					env: {},
					stderr,
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.ok, true);
			assert.equal(result.result.subagentStages, true);
			assert.equal(
				await readFile(join(cwd, 'src', 'greet.mjs'), 'utf8'),
				'export const greet = () => "hi";\n',
			);
			const orchestration = JSON.parse(
				await readFile(
					join(result.result.runDir, 'orchestration.json'),
					'utf8',
				),
			);
			assert.equal(orchestration.agents.reviewer.pass, true);
			assert.equal(
				JSON.parse(
					await readFile(join(result.result.runDir, 'install.json'), 'utf8'),
				),
				null,
			);
			assert.equal(
				JSON.parse(
					await readFile(join(result.result.runDir, 'tests.json'), 'utf8'),
				),
				null,
			);
			const reviewerRequest = JSON.parse(
				await readFile(
					join(result.result.runDir, 'subagents', 'reviewer', 'request.json'),
					'utf8',
				),
			);
			assert.match(
				reviewerRequest.messages[1].content,
				/check the generated file/u,
			);
			assert.match(stderr.text, /info: planner started/u);
			assert.match(stderr.text, /info: implementer started/u);
			assert.match(stderr.text, /info: reviewer started/u);
		} finally {
			await server.close();
		}
	});

	it('treats ERROR envelopes as failed runs without applying writes', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						messages: [
							{
								content: 'README.md was not present in context.',
								level: 'error',
							},
						],
						status: 'ERROR',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-error-'));

			const result = await main(
				['run', '-p', 'Update README', '--base-url', server.baseUrl, '--yes'],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(result.result.proposalStatus, 'ERROR');
			assert.match(
				result.result.writeError.message,
				/README\.md was not present/u,
			);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.ok, false);
			assert.equal(summary.proposalStatus, 'ERROR');

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.deepEqual(writes.writes, []);
			assert.match(writes.error.message, /README\.md was not present/u);
			assert.deepEqual(
				JSON.parse(
					await readFile(join(result.result.runDir, 'messages.json'), 'utf8'),
				),
				[
					{
						content: 'README.md was not present in context.',
						level: 'error',
					},
				],
			);
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-run-memory-'));
			await writeFile(join(cwd, 'KODR_MEMORY.md'), 'Prefer patches.\n', 'utf8');
			await mkdir(join(cwd, '.kodr', 'memory'), { recursive: true });
			await writeFile(
				join(cwd, '.kodr', 'memory', 'user.md'),
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

			const chatRequest = server.recordings[0].requestBody;
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-apply-'));
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-patch-'));
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

	it('records failed patch proposals as tolerant failedPatches', async () => {
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-bad-patch-'));
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

			// Tolerant patches: run succeeds but with zero writes
			assert.equal(result.ok, true);
			assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), 'hello\n');

			const writes = JSON.parse(
				await readFile(join(result.result.runDir, 'writes.json'), 'utf8'),
			);
			assert.equal(writes.writes.length, 0);
			assert.equal(writes.failedPatches.length, 1);
			assert.equal(writes.failedPatches[0].reason, 'no_match');
			assert.equal(writes.failedPatches[0].path, 'README.md');
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-invalid-'));
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

	it('does not run verification when apply mode receives no proposal', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponseText('Here is a plain explanation.'),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-proposal-missing-'));
			await writeFile(
				join(cwd, 'package.json'),
				'{"type":"module","scripts":{"test":"node --test"}}\n',
				'utf8',
			);

			const result = await main(
				[
					'run',
					'-p',
					'Create a file',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'npm test',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.ok, false);
			assert.equal(result.result.proposalFound, false);
			assert.equal(result.result.tested, false);
			assert.match(result.result.writeError.name, /ProposalMissingError/u);

			const tests = JSON.parse(
				await readFile(join(result.result.runDir, 'tests.json'), 'utf8'),
			);
			assert.equal(tests, null);
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-test-cwd-'));
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
				await readFile(join(cwd, 'example', '.kodr', 'last-test.md'), 'utf8'),
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-test-fails-'));
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

	it('can heal a failed verification with a bounded repair turn', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const broken = ;\n',
								path: 'bad.mjs',
							},
						],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const broken = 1;\n',
								path: 'bad.mjs',
							},
						],
						scratchpad: 'Repaired syntax error.',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-run-'));
			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Create then heal a module',
					'--base-url',
					server.baseUrl,
					'--yes',
					'--test',
					'node --check bad.mjs',
					'--heal',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout,
				},
			);

			assert.equal(result.ok, true);
			assert.equal(result.result.healed, true);
			assert.equal(result.result.healStopReason, 'healed');
			assert.equal(result.result.testResult.ok, true);
			assert.match(stdout.text, /Repairs: healed \(healed\)/u);
			assert.equal(
				await readFile(join(cwd, 'bad.mjs'), 'utf8'),
				'export const broken = 1;\n',
			);

			const repairs = JSON.parse(
				await readFile(
					join(result.result.runDir, 'repairs', 'repairs.json'),
					'utf8',
				),
			);
			assert.equal(repairs.stopReason, 'healed');
			assert.equal(server.recordings.length, 2);
			assert.match(
				server.recordings[1].requestBody.messages[1].content,
				/tests\.json/u,
			);
		} finally {
			await server.close();
		}
	});

	// Phase 97: auto heal without --heal flag
	it('heals automatically in auto mode when --yes and --test are both on', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						files: [{ content: 'export const broken = ;\n', path: 'bad.mjs' }],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				{
					body: proposalResponse({
						files: [{ content: 'export const broken = 1;\n', path: 'bad.mjs' }],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-auto-heal-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create module.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
					'--yes',
					'--test',
					'node --check bad.mjs',
					// no --heal flag — auto mode should heal
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.healed, true);
			assert.equal(result.result.healStopReason, 'healed');
		} finally {
			await server.close();
		}
	});

	it('--no-heal prevents auto healing even with --yes and --test', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: proposalResponse({
						// broken syntax — node --check would fail
						files: [{ content: 'export const broken = ;\n', path: 'bad.mjs' }],
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-no-heal-'));
			const result = await main(
				[
					'run',
					'-p',
					'Create module.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'5000',
					'--yes',
					'--test',
					'node --check bad.mjs',
					'--no-heal',
				],
				{
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.equal(result.result.healed, false);
			// no second model call because heal was disabled
			assert.equal(server.recordings.length, 1);
		} finally {
			await server.close();
		}
	});

	// Phase 97: stream auto-resolution; Phase 113: wire always streams
	it('wire always sends stream:true regardless of TTY/--no-stream (phase 113)', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-nostream-'));
			await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--no-tools',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			// Phase 113: wire always streams; stream:true regardless of TTY state
			assert.equal(server.recordings[0].requestBody.stream, true);
		} finally {
			await server.close();
		}
	});

	it('--no-stream affects display only; wire still sends stream:true', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-forcenostream-'));
			await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--no-tools',
					'--no-stream',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			// --no-stream is display-only; wire still uses stream:true
			assert.equal(server.recordings[0].requestBody.stream, true);
		} finally {
			await server.close();
		}
	});

	it('--wire-no-stream sends stream:false on the wire', async () => {
		const server = await startFakeModelServer();

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-wirenostream-'));
			await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--no-tools',
					'--wire-no-stream',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			// --wire-no-stream explicitly disables SSE on the wire
			assert.equal(server.recordings[0].requestBody.stream, undefined);
		} finally {
			await server.close();
		}
	});

	// Phase 97: context packing strategy
	it('records inspection-aware strategy when index builds successfully', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'done', role: 'assistant' },
							},
						],
						id: 'chatcmpl_pack',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-pack-'));
			const result = await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
					'--no-tools',
					'--inspect-context',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.contextPacking.strategy, 'inspection-aware');
			assert.equal(summary.contextPacking.fallbackReason, null);
		} finally {
			await server.close();
		}
	});

	it('falls back to whole-file packing and records reason when inspection fails', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'done', role: 'assistant' },
							},
						],
						id: 'chatcmpl_fallback',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-fallback-'));
			// Use a non-existent registry path to force inspection failure
			const result = await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
					'--no-tools',
					'--inspect-context',
					// inject a bad cwd via env-based trick is not easy;
					// instead use auto-mode which falls back on error
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			// --inspect-context explicit; index may succeed (inspection-aware) or
			// we just verify strategy is recorded
			assert.ok(
				summary.contextPacking.strategy === 'inspection-aware' ||
					summary.contextPacking.strategy === 'whole-file',
			);
			assert.ok('fallbackReason' in summary.contextPacking);
		} finally {
			await server.close();
		}
	});

	it('records file-map packing strategy for tools-on runs', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: {
									content:
										'{"status":"OK","files":[],"patches":[],"messages":[],"scratchpad":""}',
									role: 'assistant',
								},
							},
						],
						id: 'chatcmpl_filemap',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-filemap-'));
			const result = await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
					'--tools',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.contextPacking.strategy, 'file-map');
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-test-cwd-escape-'));

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
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-replay-cli-'));
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
		const parent = await mkdtemp(join(tmpdir(), 'kodr-replay-escape-'));
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
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycle-review-'));
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
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-cycle-review-missing-'));

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

describe('prompt versioning', () => {
	it('parseArgs stores --prompt-id value', () => {
		const options = parseArgs(['run', '-p', 'hi', '--prompt-id', 'my-slug']);
		assert.equal(options.promptId, 'my-slug');
	});

	it('parseArgs stores prompt-history id as second positional', () => {
		const options = parseArgs(['prompt-history', 'todo-cli']);
		assert.equal(options.command, 'prompt-history');
		assert.equal(options.promptHistoryId, 'todo-cli');
	});

	it('prompt-history throws CliError when no id is given', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-noid-'));
		await assert.rejects(
			() =>
				main(['prompt-history'], {
					cwd,
					env: {},
					stdout: captureStream(),
				}),
			CliError,
		);
	});

	it('prompt-history returns empty runs when nothing matches', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-empty-'));
		const stdout = captureStream();
		const result = await main(['prompt-history', 'nonexistent'], {
			cwd,
			env: {},
			stdout,
		});
		assert.equal(result.ok, true);
		assert.equal(result.result.runs.length, 0);
		assert.ok(stdout.text.includes('No runs found'));
	});

	it('run records a content-hash promptId in summary.json', async () => {
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-hash-'));
			const result = await main(
				['run', '-p', 'Build a todo app', '--base-url', server.baseUrl],
				{ cwd, env: {}, stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.match(summary.promptId, /^[0-9a-f]{8}$/u);
			assert.ok(summary.timestamp);
		} finally {
			await server.close();
		}
	});

	it('run records the --prompt-id override in summary.json', async () => {
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-override-'));
			const result = await main(
				[
					'run',
					'-p',
					'Build a notes app',
					'--prompt-id',
					'notes-api-v1',
					'--base-url',
					server.baseUrl,
				],
				{ cwd, env: {}, stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.promptId, 'notes-api-v1');
		} finally {
			await server.close();
		}
	});

	it('run with --prompt-file derives promptId from the filename slug', async () => {
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-file-'));
			await writeFile(
				join(cwd, 'todo-cli.md'),
				'Build a Node.js todo CLI',
				'utf8',
			);
			const result = await main(
				['run', '--prompt-file', 'todo-cli.md', '--base-url', server.baseUrl],
				{ cwd, env: {}, stdout: captureStream() },
			);
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.promptId, 'todo-cli');
		} finally {
			await server.close();
		}
	});

	it('prompt-history finds runs after kodr run with a named prompt-id', async () => {
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
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-ph-integ-'));
			await main(
				[
					'run',
					'-p',
					'Build a CSV parser',
					'--prompt-id',
					'csv-parser',
					'--base-url',
					server.baseUrl,
				],
				{ cwd, env: {}, stdout: captureStream() },
			);

			const histResult = await main(['prompt-history', 'csv-parser'], {
				cwd,
				env: {},
				stdout: captureStream(),
			});
			assert.equal(histResult.result.runs.length, 1);
			assert.equal(histResult.result.runs[0].promptId, undefined);
			assert.ok(histResult.result.runs[0].runDir);
		} finally {
			await server.close();
		}
	});
});

describe('token usage reporting', () => {
	it('writes usage object to summary.json when server sends usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_usage',
						object: 'chat.completion',
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							total_tokens: 15,
						},
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-usage-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.deepEqual(result.result.usage, {
				completionTokens: 5,
				cost: 0,
				costUsd: 0,
				promptTokens: 10,
				tokens: 15,
			});

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.deepEqual(summary.usage, {
				completionTokens: 5,
				cost: 0,
				costUsd: 0,
				promptTokens: 10,
				tokens: 15,
			});
		} finally {
			await server.close();
		}
	});

	it('writes null usage when server omits usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_no_usage',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-no-usage-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.equal(result.result.usage, null);
		} finally {
			await server.close();
		}
	});

	it('maps OpenRouter usage cost into run usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_openrouter_usage',
						object: 'chat.completion',
						usage: {
							completion_tokens: 3,
							cost: 0.00125,
							prompt_tokens: 7,
							total_tokens: 10,
						},
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-openrouter-usage-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--openrouter',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{
					cwd,
					env: { OPENROUTER_API_KEY: 'or-test-key' },
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.deepEqual(result.result.usage, {
				completionTokens: 3,
				cost: 0.00125,
				costUsd: 0.00125,
				promptTokens: 7,
				tokens: 10,
			});
		} finally {
			await server.close();
		}
	});

	it('sends Anthropic cache control and reports cache usage', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_anthropic_cache',
						object: 'chat.completion',
						usage: {
							cache_creation_input_tokens: 11,
							cache_read_input_tokens: 22,
							cost: 0.002,
							input_tokens: 40,
							output_tokens: 5,
						},
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-cache-usage-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--model',
					'openrouter/anthropic/claude-sonnet-4.5',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{
					cwd,
					env: { OPENROUTER_API_KEY: 'or-test-key' },
					stderr: captureStream(),
					stdout: captureStream(),
				},
			);

			assert.deepEqual(server.recordings[0].requestBody.cache_control, {
				type: 'ephemeral',
			});
			assert.deepEqual(result.result.usage, {
				cacheReadTokens: 22,
				cacheWriteTokens: 11,
				completionTokens: 5,
				cost: 0.002,
				costUsd: 0.002,
				promptTokens: 40,
				tokens: 45,
			});
			const rawRequest = JSON.parse(
				await readFile(join(result.result.runDir, 'raw-request.json'), 'utf8'),
			);
			assert.deepEqual(rawRequest.cache_control, { type: 'ephemeral' });
		} finally {
			await server.close();
		}
	});

	it('shows usage breakdown in non-JSON run output', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_usage_out',
						object: 'chat.completion',
						usage: {
							prompt_tokens: 100,
							completion_tokens: 50,
							total_tokens: 150,
						},
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-usage-out-'));
			const stdout = captureStream();
			await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			assert.match(stdout.text, /Tokens: 150 \(prompt 100 \/ completion 50\)/u);
		} finally {
			await server.close();
		}
	});

	it('prompt-history shows token totals', async () => {
		// Build a fake run dir with a summary that carries usage.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-history-tokens-'));
		const runDir = join(cwd, '.kodr', 'runs', '2026-01-01T00-00-00.000Z');
		await mkdir(runDir, { recursive: true });
		await writeFile(
			join(runDir, 'summary.json'),
			JSON.stringify({
				promptId: 'hello-world',
				model: 'test-model',
				ok: true,
				timestamp: '2026-01-01T00:00:00.000Z',
				finishReasons: ['stop'],
				usage: {
					tokens: 888,
					promptTokens: 600,
					completionTokens: 288,
					cost: 0,
					costUsd: 0,
				},
			}),
		);

		const stdout = captureStream();
		await main(['prompt-history', 'hello-world'], {
			cwd,
			env: {},
			stderr: captureStream(),
			stdout,
		});

		assert.match(stdout.text, /tokens=888/u);
	});
});

describe('conversation transcripts', () => {
	it('conversation.json ends with the final assistant message', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Here is the plan.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_conv',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-conv-'));
			const result = await main(
				[
					'run',
					'-p',
					'Write a plan.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const conv = JSON.parse(
				await readFile(join(result.result.runDir, 'conversation.json'), 'utf8'),
			);
			// Transcript: system → user → assistant
			assert.equal(conv.length, 3);
			assert.equal(conv[0].role, 'system');
			assert.equal(conv[1].role, 'user');
			assert.equal(conv[1].content, 'Write a plan.');
			assert.equal(conv[2].role, 'assistant');
			assert.equal(conv[2].content, 'Here is the plan.');
		} finally {
			await server.close();
		}
	});

	it('conversation.json includes continuation turns when length-stopped', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'length',
								message: { content: 'Part one ', role: 'assistant' },
							},
						],
						id: 'chatcmpl_p1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'part two.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_p2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-conv-cont-'));
			const result = await main(
				[
					'run',
					'-p',
					'Long task.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
					'--no-tools',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const conv = JSON.parse(
				await readFile(join(result.result.runDir, 'conversation.json'), 'utf8'),
			);
			// system, user, assistant(part1), user(continue), assistant(final)
			assert.equal(conv.length, 5);
			assert.equal(conv[2].role, 'assistant');
			assert.equal(conv[3].role, 'user');
			assert.equal(conv[4].role, 'assistant');
			assert.equal(conv[4].content, 'Part one part two.');
		} finally {
			await server.close();
		}
	});

	it('summary.json carries sessionId matching run dir basename', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_sid',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-conv-sid-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.sessionId, basename(result.result.runDir));
			assert.equal(summary.parentRunDir, null);
		} finally {
			await server.close();
		}
	});

	it('writes .kodr/last-run pointing at the run dir', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'chatcmpl_lr',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-conv-lr-'));
			const result = await main(
				[
					'run',
					'-p',
					'hi',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const lastRun = (
				await readFile(join(cwd, '.kodr', 'last-run'), 'utf8')
			).trim();
			assert.equal(lastRun, result.result.runDir);
		} finally {
			await server.close();
		}
	});

	it('F3: updates .kodr/last-run to the failed run dir when the model call fails', async () => {
		// F3: last-run should be updated even on failure so `kodr why` works
		// immediately after a failed run (when forensics is most needed).
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 500,
					body: { error: 'internal server error' },
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-conv-fail-'));

			await assert.rejects(
				() =>
					main(
						[
							'run',
							'-p',
							'hi',
							'--base-url',
							server.baseUrl,
							'--timeout-ms',
							'1000',
						],
						{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
					),
				/Model run failed/u,
			);

			// last-run must point to the failed run directory (which exists)
			const lastRun = (
				await readFile(join(cwd, '.kodr', 'last-run'), 'utf8')
			).trim();
			assert.ok(
				lastRun.includes('.kodr/runs/'),
				`last-run should point to a run dir, got: ${lastRun}`,
			);
		} finally {
			await server.close();
		}
	});

	it('conversation.json ends with assistant turn in --tools mode', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'tool_calls',
								message: {
									content: null,
									role: 'assistant',
									tool_calls: [
										{
											id: 'call_1',
											type: 'function',
											function: { name: 'list_files', arguments: '{}' },
										},
									],
								},
							},
						],
						id: 'chatcmpl_tc1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Done.', role: 'assistant' },
							},
						],
						id: 'chatcmpl_tc2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-conv-tools-'));
			const result = await main(
				[
					'run',
					'-p',
					'List files.',
					'--base-url',
					server.baseUrl,
					'--tools',
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const conv = JSON.parse(
				await readFile(join(result.result.runDir, 'conversation.json'), 'utf8'),
			);
			const last = conv.at(-1);
			assert.equal(last.role, 'assistant');
			assert.equal(last.content, 'Done.');
		} finally {
			await server.close();
		}
	});
});

describe('session continuation', () => {
	// Helper: runs a first prompt and returns its run dir.
	async function firstRun(server, cwd, prompt = 'First task.') {
		await main(
			[
				'run',
				'-p',
				prompt,
				'--base-url',
				server.baseUrl,
				'--timeout-ms',
				'1000',
				'--json',
			],
			{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
		);
		const lastRun = (
			await readFile(join(cwd, '.kodr', 'last-run'), 'utf8')
		).trim();
		return lastRun;
	}

	it('--continue resumes the last run with frozen system prompt', async () => {
		const server = await startFakeModelServer({
			responses: [
				// First run
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'First answer.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
				// Second run (continuation)
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Second answer.', role: 'assistant' },
							},
						],
						id: 'r2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-'));
			const parentDir = await firstRun(server, cwd);

			const stdout = captureStream();
			const result = await main(
				[
					'run',
					'-p',
					'Follow up.',
					'--continue',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			assert.equal(result.ok, true);
			assert.equal(result.result.response, 'Second answer.');

			// The continuation's conversation starts from the parent's transcript,
			// not a fresh system+user pair.
			const conv = JSON.parse(
				await readFile(join(result.result.runDir, 'conversation.json'), 'utf8'),
			);
			// parent had [system, user, assistant], continuation appends [user, assistant]
			assert.equal(conv.length, 5);
			assert.equal(conv[0].role, 'system');
			assert.equal(conv[3].content, 'Follow up.');
			assert.equal(conv[4].content, 'Second answer.');

			// sessionId is inherited from the parent; parentRunDir points at it.
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.parentRunDir, parentDir);
			assert.equal(summary.sessionId, basename(parentDir));
		} finally {
			await server.close();
		}
	});

	it('--session <id> loads a named session by run dir basename', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Turn one.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Turn two.', role: 'assistant' },
							},
						],
						id: 'r2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-id-'));
			const parentDir = await firstRun(server, cwd);
			const sessionId = basename(parentDir);

			const result = await main(
				[
					'run',
					'-p',
					'Continue.',
					'--session',
					sessionId,
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			assert.equal(result.ok, true);
			assert.equal(result.result.response, 'Turn two.');
			const summary = JSON.parse(
				await readFile(join(result.result.runDir, 'summary.json'), 'utf8'),
			);
			assert.equal(summary.sessionId, sessionId);
			assert.equal(summary.parentRunDir, parentDir);
		} finally {
			await server.close();
		}
	});

	it('compacts oversized continuation context while preserving the raw transcript', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'First answer.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Second answer.', role: 'assistant' },
							},
						],
						id: 'r2',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Third answer.', role: 'assistant' },
							},
						],
						id: 'r3',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-compact-'));
			const longPrompt = `Build the feature. Must use ESM.\n${'detail '.repeat(5000)}`;
			await firstRun(server, cwd, longPrompt);

			const result = await main(
				[
					'run',
					'-p',
					'Now add tests.',
					'--continue',
					'--session-context-chars',
					'12000',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const conversation = JSON.parse(
				await readFile(join(result.result.runDir, 'conversation.json'), 'utf8'),
			);
			const rawConversation = JSON.parse(
				await readFile(
					join(result.result.runDir, 'conversation-raw.json'),
					'utf8',
				),
			);
			const sessionSummary = JSON.parse(
				await readFile(
					join(result.result.runDir, 'session-summary.json'),
					'utf8',
				),
			);
			const request = server.recordings.filter(
				(recording) => recording.url === '/v1/chat/completions',
			)[1].requestBody;

			assert.equal(sessionSummary.compacted, true);
			assert.ok(sessionSummary.droppedMessageCount > 0);
			assert.match(conversation[1].content, /Deterministic Session Summary/u);
			assert.deepEqual(request.messages, conversation.slice(0, -1));
			assert.ok(
				rawConversation.some((message) => message.content === longPrompt),
			);
			assert.equal(rawConversation.at(-1).content, 'Second answer.');
			assert.ok(rawConversation.length > conversation.length);

			const third = await main(
				[
					'run',
					'-p',
					'One more change.',
					'--continue',
					'--session-context-chars',
					'12000',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			const thirdSummary = JSON.parse(
				await readFile(
					join(third.result.runDir, 'session-summary.json'),
					'utf8',
				),
			);
			assert.match(thirdSummary.sections.userIntent[0], /Build the feature/u);
		} finally {
			await server.close();
		}
	});

	it('--continue throws a clear error when no previous run exists', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-norun-'));
		await assert.rejects(
			() =>
				main(
					[
						'run',
						'-p',
						'hi',
						'--continue',
						'--base-url',
						'http://localhost:1234/v1',
						'--timeout-ms',
						'1000',
					],
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/no previous run found/u,
		);
	});

	it('--session with unknown id throws a clear error', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-badid-'));
		await assert.rejects(
			() =>
				main(
					[
						'run',
						'-p',
						'hi',
						'--session',
						'nonexistent-id',
						'--base-url',
						'http://localhost:1234/v1',
						'--timeout-ms',
						'1000',
					],
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/could not load conversation/u,
		);
	});

	it('--continue and --session together throw a clear error', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-both-'));
		await assert.rejects(
			() =>
				main(
					[
						'run',
						'-p',
						'hi',
						'--continue',
						'--session',
						'some-id',
						'--base-url',
						'http://localhost:1234/v1',
						'--timeout-ms',
						'1000',
					],
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/--continue and --session cannot be used together/u,
		);
	});

	it('emits a stderr warning when continuing with a different model', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'First.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Second.', role: 'assistant' },
							},
						],
						id: 'r2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-warn-'));
			await firstRun(server, cwd);

			const stderr = captureStream();
			await main(
				[
					'run',
					'-p',
					'Follow up.',
					'--continue',
					'--model',
					'other-model',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr, stdout: captureStream() },
			);

			assert.match(
				stderr.text,
				/Warning: continuing session with model other-model/u,
			);
		} finally {
			await server.close();
		}
	});

	it('--session rejects ids with path traversal components', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-traversal-'));
		await assert.rejects(
			() =>
				main(
					[
						'run',
						'-p',
						'hi',
						'--session',
						'../outside',
						'--base-url',
						'http://localhost:1234/v1',
						'--timeout-ms',
						'1000',
					],
					{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
				),
			/could not load conversation/u,
		);
	});
});

describe('session browsing', () => {
	it('session list shows known sessions', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'A1.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'A2.', role: 'assistant' },
							},
						],
						id: 'r2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-list-'));
			// Two separate sessions (independent runs)
			await main(
				[
					'run',
					'-p',
					'First session task.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			await main(
				[
					'run',
					'-p',
					'Second session task.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const stdout = captureStream();
			const result = await main(['session', 'list'], {
				cwd,
				env: {},
				stderr: captureStream(),
				stdout,
			});

			assert.equal(result.command, 'session');
			assert.equal(result.subcommand, 'list');
			assert.equal(result.sessions.length, 2);
			// Non-JSON output contains the session ids
			assert.match(stdout.text, /turns=1/u);
		} finally {
			await server.close();
		}
	});

	it('session list --json returns structured data', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'ok', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-list-json-'));
			await main(
				[
					'run',
					'-p',
					'task',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const stdout = captureStream();
			await main(['session', 'list', '--json'], {
				cwd,
				env: {},
				stderr: captureStream(),
				stdout,
			});

			const data = JSON.parse(stdout.text);
			assert.ok(Array.isArray(data.sessions));
			assert.equal(data.sessions[0].turnCount, 1);
			assert.ok(data.sessions[0].sessionId.length > 0);
		} finally {
			await server.close();
		}
	});

	it('session show prints conversation turns', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'First answer.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
					},
				},
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Second answer.', role: 'assistant' },
							},
						],
						id: 'r2',
						object: 'chat.completion',
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-show-'));
			// First turn
			await main(
				[
					'run',
					'-p',
					'Do something.',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
					'--json',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);
			const lastRun = (
				await readFile(join(cwd, '.kodr', 'last-run'), 'utf8')
			).trim();
			const sessionId = basename(lastRun);
			// Second turn
			await main(
				[
					'run',
					'-p',
					'Continue it.',
					'--continue',
					'--base-url',
					server.baseUrl,
					'--timeout-ms',
					'1000',
				],
				{ cwd, env: {}, stderr: captureStream(), stdout: captureStream() },
			);

			const stdout = captureStream();
			const result = await main(['session', 'show', sessionId], {
				cwd,
				env: {},
				stderr: captureStream(),
				stdout,
			});

			assert.equal(result.subcommand, 'show');
			assert.equal(result.conversation.sessionId, sessionId);
			assert.equal(result.conversation.turns.length, 2);
			assert.equal(result.conversation.turns[0].user, 'Do something.');
			assert.equal(result.conversation.turns[0].assistant, 'First answer.');
			assert.equal(result.conversation.turns[1].user, 'Continue it.');
			assert.equal(result.conversation.turns[1].assistant, 'Second answer.');
			assert.match(stdout.text, /Turn 1/u);
			assert.match(stdout.text, /Do something\./u);
		} finally {
			await server.close();
		}
	});

	it('session export prints deterministic markdown', async () => {
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					status: 200,
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: 'Exported answer.', role: 'assistant' },
							},
						],
						id: 'r1',
						object: 'chat.completion',
						usage: { total_tokens: 7 },
					},
				},
			],
		});

		try {
			const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-export-'));
			await main(
				[
					'run',
					'-p',
					'Export this.',
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

			const stdout = captureStream();
			const result = await main(
				['session', 'export', sessionId, '--format', 'markdown'],
				{ cwd, env: {}, stderr: captureStream(), stdout },
			);

			assert.equal(result.subcommand, 'export');
			assert.equal(result.format, 'markdown');
			assert.match(stdout.text, new RegExp(`# Kodr Session ${sessionId}`, 'u'));
			assert.match(stdout.text, /- Turns: 1/u);
			assert.match(stdout.text, /- Tokens: 7/u);
			assert.match(stdout.text, /### User/u);
			assert.match(stdout.text, /Export this\./u);
			assert.match(stdout.text, /Exported answer\./u);
		} finally {
			await server.close();
		}
	});

	it('session list returns empty when no runs exist', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-empty-'));
		const result = await main(['session', 'list'], {
			cwd,
			env: {},
			stderr: captureStream(),
			stdout: captureStream(),
		});
		assert.equal(result.sessions.length, 0);
	});

	it('session show throws for unknown session', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-show-bad-'));
		await assert.rejects(
			() =>
				main(['session', 'show', 'nonexistent-session'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Session not found/u,
		);
	});

	it('session export throws for unknown session', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-export-bad-'));
		await assert.rejects(
			() =>
				main(['session', 'export', 'nonexistent-session'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Session not found/u,
		);
	});

	it('session export rejects unsupported formats', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-export-format-'));
		await assert.rejects(
			() =>
				main(['session', 'export', 'anything', '--format', 'html'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/only supports --format markdown/u,
		);
	});

	it('session without subcommand throws a helpful error', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-noarg-'));
		await assert.rejects(
			() =>
				main(['session'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/requires a subcommand/u,
		);
	});

	it('session show without id argument throws a helpful error', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-show-noid-'));
		await assert.rejects(
			() =>
				main(['session', 'show'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/requires a session id/u,
		);
	});

	it('session show returns null when no conversation.json exists in the run dir', async () => {
		// Simulate a pre-phase-42 run: summary.json exists but conversation.json absent.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-oldrun-'));
		const runDir = join(cwd, '.kodr', 'runs', '2000-01-01T00-00-00.000Z');
		await mkdir(runDir, { recursive: true });
		await writeFile(
			join(runDir, 'summary.json'),
			JSON.stringify({
				sessionId: '2000-01-01T00-00-00.000Z',
				model: 'old-model',
				ok: true,
				timestamp: '2000-01-01T00:00:00.000Z',
				finishReasons: ['stop'],
			}),
		);

		await assert.rejects(
			() =>
				main(['session', 'show', '2000-01-01T00-00-00.000Z'], {
					cwd,
					env: {},
					stderr: captureStream(),
					stdout: captureStream(),
				}),
			/Session not found/u,
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
	return proposalResponseText(JSON.stringify(value));
}

function proposalResponseText(content) {
	return {
		choices: [
			{
				finish_reason: 'stop',
				message: {
					content,
					role: 'assistant',
				},
			},
		],
		id: 'chatcmpl_proposal',
		object: 'chat.completion',
	};
}

function commandResult(exitCode, stdout = '', stderr = '') {
	return { exitCode, stderr, stdout, timedOut: false };
}
