import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createRunArtifacts, writeJson, writeText } from './artifacts.mjs';
import { loadConfiguredHooks, writeHookArtifact } from './command-hooks.mjs';
import {
	buildWorkspaceContext,
	listContextFiles,
	renderContextMarkdown,
} from './context-packer.mjs';
import { extractProposal } from './json-extractor.mjs';
import {
	buildChatRequestBody,
	createChatCompletion,
	firstAssistantMessage,
	firstModelId,
	listModels,
} from './model-client.mjs';
import { loadMemory } from './memory.mjs';
import { jailedPath, prepareChanges } from './safe-writes.mjs';
import { discoverSkills, loadSkills, renderSkillIndex } from './skills.mjs';
import { createCycleReviewRequest, runSubagent } from './subagents.mjs';
import {
	createInspectionTaskPlan,
	createTaskPlan,
	renderInspectionTaskPlan,
	taskCounts,
	updateTasksFromRun,
} from './task-plan.mjs';
import { runSelfHealingLoop } from './healing.mjs';
import {
	parseVerificationCommand,
	runVerification,
} from './verification-runner.mjs';
import { replayRun } from './replay.mjs';
import { completeWithToolCalls, createBuiltinRegistry } from './tool-calls.mjs';
import { runComparison } from './compare.mjs';
import { runSubagentStages } from './orchestration.mjs';
import {
	emitProgress,
	formatProgressEvent,
	runStartHook,
} from './progress.mjs';
import {
	proposalResponseFormat,
	responseFormatForRequest,
} from './structured-output.mjs';
import {
	ModelSpecError,
	parseAgentModelOverride,
	resolveAgentModels,
	resolveModelOptions,
} from './model-specs.mjs';
import { applyModelProfileDefaults } from './model-profiles.mjs';
import { loadEvalSuite, scoreCase } from './eval.mjs';
import { startKodrServer } from './server.mjs';
import { inspectWorkspace } from './code-inspector.mjs';
import {
	filterInspectionIndex,
	renderInspection,
} from './inspection-output.mjs';
import { runDependencyInstall } from './dependency-installer.mjs';
import { dockerDefaults, validateDockerOptions } from './docker-executor.mjs';
import {
	openshellDefaults,
	validateOpenShellOptions,
} from './openshell-executor.mjs';
import { runOpenShellWorker } from './openshell-worker.mjs';
import {
	createActiveExecutor,
	executorCommandRunner,
	finalizeExecutor,
	initializeExecutor,
	writeExecutorArtifacts,
} from './active-executor.mjs';
import {
	checkAvailability,
	inspectWithRegistry,
	REGISTRY,
} from './external-inspector-registry.mjs';
import {
	completeWithContinuations,
	OPENROUTER_BASE_URL,
	OPENROUTER_EXTRA_HEADERS,
} from './completion.mjs';
import { derivePromptId, promptIdFromFilename } from './prompt-id.mjs';
import {
	loadSessionConversation,
	scanRunHistory,
	scanSessions,
} from './run-history.mjs';
import {
	appendCompletionToRawConversation,
	compactSessionConversation,
	DEFAULT_SESSION_CONTEXT_CHARS,
	loadSessionEvidence,
} from './session-compaction.mjs';
import { runTui } from './tui.mjs';
import { VERSION } from './version.mjs';

export { VERSION };

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL_ID = 'qwen/qwen3.6-35b-a3b';
const DEFAULT_TIMEOUT_MS = 600000;
// The reviewer is advisory and non-fatal, so it fails fast by default rather
// than tying up a full model timeout. Capped against --timeout-ms and
// overridable with --review-timeout-ms.
const DEFAULT_REVIEW_TIMEOUT_MS = 180000;
const DEFAULT_SERVE_HOST = '127.0.0.1';
const DEFAULT_SERVE_PORT = 8787;
const PROBE_PROMPT = 'Reply with exactly: kodr-probe-ok';

const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';

export class CliError extends Error {
	constructor(message) {
		super(message);
		this.name = 'CliError';
	}
}

export function parseArgs(argv, env = {}) {
	const options = {
		baseUrl: env.BASE_URL || DEFAULT_BASE_URL,
		command: 'help',
		completionReserve: '',
		contextWindow: '',
		dockerImage: '',
		dockerKeep: false,
		dockerNetwork: '',
		dockerSandbox: false,
		dockerWorkdir: '',
		openshellFrom: '',
		openshellKeep: false,
		openshellPolicy: '',
		openshellSandbox: false,
		openshellWorker: false,
		dryRun: true,
		extraHeaders: {},
		help: false,
		heal: false,
		enableHooks: false,
		agentModels: {},
		agentModelSpecs: {},
		hooksConfigPath: '',
		inspectFile: '',
		inspectSymbol: '',
		inspectLanguages: [],
		inspectContext: false,
		installDependencies: false,
		json: false,
		model: env.MODEL_ID || DEFAULT_MODEL_ID,
		out: '',
		apiKey: env.OPENAI_API_KEY || '',
		prompt: '',
		promptCache: 'auto',
		promptFile: '',
		provider: 'local',
		replayDir: '',
		showContext: false,
		showFiles: false,
		showSkills: false,
		skills: [],
		stream: false,
		suitePath: '',
		testCommand: '',
		models: [],
		continueSession: false,
		priorScratchpadPath: '',
		promptId: '',
		promptHistoryId: '',
		sessionId: '',
		sessionContextChars: DEFAULT_SESSION_CONTEXT_CHARS,
		sessionFormat: 'markdown',
		sessionSubcommand: '',
		serveHost: DEFAULT_SERVE_HOST,
		servePort: DEFAULT_SERVE_PORT,
		staged: 'auto',
		subagentStages: false,
		skipReview: false,
		reviewTimeoutMs: '',
		tools: false,
		testCwd: '',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		transcriptFile: '',
		maxCostUsd: '',
		maxRetries: 7,
		maxThinkingTokens: '',
		maxTokens: '',
		maxTurns: 8,
		version: false,
		yes: false,
		_apiKeySet: false,
		_baseUrlSet: false,
		_completionReserveSet: false,
		_contextWindowSet: false,
		_modelSet: false,
		_sessionContextSet: false,
		_timeoutSet: false,
	};

	const positionals = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];

		if (arg === '-h' || arg === '--help') {
			options.help = true;
			continue;
		}

		if (arg === '--version') {
			options.version = true;
			continue;
		}

		if (arg === '--json') {
			options.json = true;
			continue;
		}

		if (arg === '--dry-run') {
			options.dryRun = true;
			continue;
		}

		if (arg === '--yes') {
			options.dryRun = false;
			options.yes = true;
			continue;
		}

		if (arg === '--protect-existing') {
			options.protectExisting = true;
			continue;
		}

		if (arg === '--show-context') {
			options.showContext = true;
			continue;
		}

		if (arg === '--inspect-context') {
			options.inspectContext = true;
			continue;
		}

		if (arg === '--show-files') {
			options.showFiles = true;
			continue;
		}

		if (arg === '--show-skills') {
			options.showSkills = true;
			continue;
		}

		if (arg === '--stream') {
			options.stream = true;
			continue;
		}

		if (arg === '--openrouter') {
			options.provider = 'openrouter';
			continue;
		}

		if (arg === '--tools') {
			options.tools = true;
			continue;
		}

		if (arg === '--subagent-stages') {
			options.subagentStages = true;
			options.tools = true;
			continue;
		}

		if (arg === '--install') {
			options.installDependencies = true;
			continue;
		}

		if (arg === '--no-review') {
			options.skipReview = true;
			continue;
		}

		if (arg === '--heal') {
			options.heal = true;
			continue;
		}

		if (arg === '--hooks') {
			options.enableHooks = true;
			continue;
		}

		if (arg === '--docker-sandbox') {
			options.dockerSandbox = true;
			continue;
		}

		if (arg === '--docker-keep') {
			options.dockerKeep = true;
			continue;
		}

		if (arg === '--openshell-sandbox') {
			options.openshellSandbox = true;
			continue;
		}

		if (arg === '--openshell-worker') {
			options.openshellWorker = true;
			continue;
		}

		if (arg === '--openshell-keep') {
			options.openshellKeep = true;
			continue;
		}

		if (arg === '--staged') {
			options.staged = true;
			continue;
		}

		if (arg === '--no-staged') {
			options.staged = false;
			continue;
		}

		if (arg === '--continue') {
			options.continueSession = true;
			continue;
		}

		if (arg === '--models') {
			if (index + 1 >= argv.length) {
				throw new CliError(`${arg} requires a value`);
			}
			const value = argv[index + 1];
			index += 1;
			options.models = value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			continue;
		}

		if (
			arg === '--base-url' ||
			arg === '--completion-reserve' ||
			arg === '--context-window' ||
			arg === '--model' ||
			arg === '--agent-model' ||
			arg === '--api-key' ||
			arg === '--out' ||
			arg === '-p' ||
			arg === '--prompt' ||
			arg === '--prompt-file' ||
			arg === '--prompt-cache' ||
			arg === '--prompt-id' ||
			arg === '--skill' ||
			arg === '--suite' ||
			arg === '--test' ||
			arg === '--test-cwd' ||
			arg === '--timeout-ms' ||
			arg === '--review-timeout-ms' ||
			arg === '--transcript-file' ||
			arg === '--format' ||
			arg === '--docker-image' ||
			arg === '--docker-network' ||
			arg === '--docker-workdir' ||
			arg === '--openshell-from' ||
			arg === '--openshell-policy' ||
			arg === '--hooks-config' ||
			arg === '--max-cost-usd' ||
			arg === '--max-retries' ||
			arg === '--max-thinking-tokens' ||
			arg === '--max-tokens' ||
			arg === '--max-turns' ||
			arg === '--session' ||
			arg === '--session-context-chars' ||
			arg === '--host' ||
			arg === '--port' ||
			arg === '--file' ||
			arg === '--symbol' ||
			arg === '--languages' ||
			arg === '--prior-scratchpad'
		) {
			// Consume the next token as the value unconditionally. An empty string
			// or a value that starts with "--" (e.g. a literal prompt) is still a
			// valid value; only a missing token is an error.
			if (index + 1 >= argv.length) {
				throw new CliError(`${arg} requires a value`);
			}
			const value = argv[index + 1];
			index += 1;
			assignValue(options, arg, value);
			continue;
		}

		if (arg.startsWith('--')) {
			throw new CliError(`Unknown option: ${arg}`);
		}

		positionals.push(arg);
	}

	if (positionals.length > 0) {
		options.command = positionals[0];
		if (options.command === 'replay' && positionals.length === 2) {
			options.replayDir = positionals[1];
		} else if (
			options.command === 'prompt-history' &&
			positionals.length === 2
		) {
			options.promptHistoryId = positionals[1];
		} else if (options.command === 'session' && positionals.length === 2) {
			// Accepts: kodr session list  OR  kodr session show <id>
			// The sub-command / id is captured via sessionId re-use.
			options.sessionSubcommand = positionals[1];
		} else if (options.command === 'session' && positionals.length === 3) {
			options.sessionSubcommand = positionals[1];
			options.sessionId = positionals[2];
		} else if (positionals.length > 1) {
			throw new CliError(
				`Unexpected positional arguments: ${positionals.slice(1).join(' ')}`,
			);
		}
	}

	if (options.provider === 'openrouter') {
		if (options.baseUrl === DEFAULT_BASE_URL && !env.BASE_URL) {
			options.baseUrl = OPENROUTER_BASE_URL;
		}
		if (options.model === (env.MODEL_ID || DEFAULT_MODEL_ID) && !env.MODEL_ID) {
			options.model = OPENROUTER_DEFAULT_MODEL;
		}
		if (!options._apiKeySet) {
			options.apiKey = env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || '';
		}
		if (!options.apiKey) {
			throw new CliError(
				'--openrouter requires OPENROUTER_API_KEY or OPENAI_API_KEY to be set',
			);
		}
		options.extraHeaders = OPENROUTER_EXTRA_HEADERS;
	}
	try {
		Object.assign(
			options,
			resolveModelOptions(options, env, options.model, {
				allowBaseUrlOverride:
					options._baseUrlSet || options.provider === 'openrouter',
			}),
		);
		Object.assign(options, applyModelProfileDefaults(options, env));
		options.agentModels = Object.fromEntries(
			Object.entries(resolveAgentModels(options, env)).map(
				([agent, modelOptions]) => [
					agent,
					applyModelProfileDefaults(
						{
							...modelOptions,
							_sessionContextSet: true,
							_timeoutSet: options._timeoutSet,
							sessionContextChars: options.sessionContextChars,
							timeoutMs: options.timeoutMs,
						},
						env,
					),
				],
			),
		);
	} catch (error) {
		if (error instanceof ModelSpecError) {
			throw new CliError(error.message);
		}
		throw error;
	}
	delete options._apiKeySet;
	delete options._baseUrlSet;
	delete options._completionReserveSet;
	delete options._contextWindowSet;
	delete options._modelSet;
	delete options._sessionContextSet;
	delete options._timeoutSet;

	if (options.dockerSandbox) {
		Object.assign(options, dockerDefaults(options));
	}
	if (options.openshellSandbox || options.openshellWorker) {
		Object.assign(options, openshellDefaults(options));
	}
	if (options.subagentStages) {
		options.tools = true;
	}

	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
		throw new CliError(
			'--timeout-ms must be an integer greater than or equal to 100',
		);
	}
	validateContextBudgetOptions(options);
	if (
		options.reviewTimeoutMs !== '' &&
		(!Number.isInteger(options.reviewTimeoutMs) ||
			options.reviewTimeoutMs < 100)
	) {
		throw new CliError(
			'--review-timeout-ms must be an integer greater than or equal to 100',
		);
	}
	validateLoopBudgetOptions(options);
	validatePromptCacheOptions(options);
	validateSessionOptions(options);
	validateServeOptions(options);
	validateDockerOptions(options);
	validateOpenShellOptions(options);

	return options;
}

function validateContextBudgetOptions(options) {
	if (
		!Number.isInteger(options.contextWindow) ||
		options.contextWindow < 1000
	) {
		throw new CliError(
			'--context-window must be an integer greater than or equal to 1000',
		);
	}
	if (
		!Number.isInteger(options.completionReserve) ||
		options.completionReserve < 0
	) {
		throw new CliError('--completion-reserve must be a non-negative integer');
	}
	if (options.completionReserve >= options.contextWindow) {
		throw new CliError(
			'--completion-reserve must be smaller than --context-window',
		);
	}
}

function validateLoopBudgetOptions(options) {
	if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
		throw new CliError(
			'--max-turns must be an integer greater than or equal to 1',
		);
	}
	if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
		throw new CliError('--max-retries must be a non-negative integer');
	}
	if (
		options.maxTokens !== '' &&
		(!Number.isInteger(options.maxTokens) || options.maxTokens < 0)
	) {
		throw new CliError('--max-tokens must be a non-negative integer');
	}
	if (
		options.maxThinkingTokens !== '' &&
		(!Number.isInteger(options.maxThinkingTokens) ||
			options.maxThinkingTokens < 0)
	) {
		throw new CliError('--max-thinking-tokens must be a non-negative integer');
	}
	if (
		options.maxCostUsd !== '' &&
		(!Number.isFinite(Number(options.maxCostUsd)) ||
			Number(options.maxCostUsd) < 0)
	) {
		throw new CliError('--max-cost-usd must be a non-negative number');
	}
}

function validatePromptCacheOptions(options) {
	if (!['auto', 'off'].includes(options.promptCache)) {
		throw new CliError('--prompt-cache must be "auto" or "off"');
	}
}

function validateSessionOptions(options) {
	if (
		!Number.isInteger(options.sessionContextChars) ||
		options.sessionContextChars < 1000
	) {
		throw new CliError(
			'--session-context-chars must be an integer greater than or equal to 1000',
		);
	}
}

function validateServeOptions(options) {
	if (!options.serveHost.trim()) {
		throw new CliError('--host must not be empty');
	}
	if (
		!Number.isInteger(options.servePort) ||
		options.servePort < 0 ||
		options.servePort > 65535
	) {
		throw new CliError('--port must be an integer from 0 to 65535');
	}
}

export function usage() {
	return `kodr ${VERSION}

Usage:
  kodr --help
  kodr --version
  kodr probe [--json]
  kodr run -p "task" [--json]
  kodr run --prompt-file prompt.md [--out .kodr/runs/name] [--prompt-id slug]
  kodr run -p "task" --dry-run
  kodr run -p "task" --yes [--install] [--test "npm test"] [--test-cwd path] [--heal]
  kodr run -p "task" --yes --docker-sandbox [--docker-keep] [--test "npm test"]
  kodr run -p "task" --yes --openshell-sandbox [--openshell-keep] [--test "npm test"]
  kodr run --prompt-file prompt.md --openshell-worker --yes [--install] [--test "npm test"]
  kodr run -p "task" --tools --hooks [--hooks-config .kodr/hooks.json]
  kodr run -p "task" --yes --protect-existing
  kodr run -p "task" --tools --yes --staged
  kodr run -p "task" --yes --subagent-stages
  kodr run -p "task" --stream
  kodr run -p "task" --tools
  kodr run -p "task" --inspect-context
  kodr run -p "follow up" --continue
  kodr run -p "follow up" --session <run-id>
  kodr tui [--session <run-id>]
  kodr tui --continue
  kodr serve [--host 127.0.0.1] [--port 8787]
  kodr inspect [--symbol name] [--file path] [--json]
  kodr registry [--json]
  kodr run --show-files
  kodr run --show-context
  kodr run --show-skills
  kodr cycle-review --transcript-file chat.md [--json]
  kodr compare -p "task" --models "m1,openrouter:m2" [--json]
  kodr eval --suite evals/suite.json [--json]
  kodr prompt-history <promptId> [--json]
  kodr session list [--json]
  kodr session show <sessionId> [--json]
  kodr session export <sessionId> --format markdown
  kodr replay <run-dir>

Local-model defaults:
  --base-url URL       Default: ${DEFAULT_BASE_URL}
  --model ID           Default: MODEL_ID or ${DEFAULT_MODEL_ID}
                       Supports provider/model specs such as lmstudio/qwen/qwen3.6-35b-a3b
                       or openrouter/openai/gpt-4o-mini.
                       Model profile overrides: .kodr/model-profiles.json or KODR_MODEL_PROFILES.
  --agent-model A=S    Override subagent model for --subagent-stages.
                       Repeatable for planner, implementer, reviewer.
  --api-key KEY        Default: OPENAI_API_KEY
  --timeout-ms N       Default: ${DEFAULT_TIMEOUT_MS}
  --context-window N   Override active profile context window.
  --completion-reserve N
                       Override active profile completion reserve.
  --max-turns N        Max model turns in a run. Default: 8
  --max-retries N      Max continuation retries after length stops. Default: 7
  --max-thinking-tokens N
                       Optional provider/model thinking-token cap.
  --prompt-cache MODE  Prompt cache policy: auto or off. Default: auto.
                       Remote Anthropic model ids receive root cache_control.
  --max-tokens N       Optional total token budget from model usage
  --max-cost-usd N     Optional cost budget when the provider reports USD usage
  --session-context-chars N
                       Compact continued session context above this character budget.
                       Default: ${DEFAULT_SESSION_CONTEXT_CHARS}

OpenRouter:
  --openrouter         Use OpenRouter as the provider (base URL: ${OPENROUTER_BASE_URL})
                       Default model: ${OPENROUTER_DEFAULT_MODEL}
                       API key: OPENROUTER_API_KEY env var (falls back to OPENAI_API_KEY)
                       All --base-url, --model, and --api-key flags still override these defaults.

  --models m1,m2       Comma-separated model specs for compare. Prefix with
                       "openrouter:" to route a model via OpenRouter.
  --prompt-id slug     Override the prompt id recorded in summary.json.
                       Defaults to a content hash for -p prompts or the
                       filename slug for --prompt-file prompts.
  --suite path         Path to an eval suite JSON file for kodr eval.
  --prior-scratchpad   Path to a scratchpad file to inject into the user message.
                       Use "last" to read from the most recent run's scratchpad.
                       Truncated to 2000 characters. Skipped if empty.
  --staged             Force plan-first staged execution for complex work.
  --no-staged          Disable automatic staged execution.
  --subagent-stages    Run planner, implementer, and reviewer as isolated tool agents.
  --no-review          Skip the advisory reviewer stage in --subagent-stages runs.
  --review-timeout-ms N  Reviewer model timeout. Default: min(--timeout-ms, ${DEFAULT_REVIEW_TIMEOUT_MS}).
  --install            Run controlled dependency install after applied writes.
                       Uses npm ci when package-lock.json exists, otherwise npm install.
  --heal               After failed verification, run a bounded repair loop.
  --hooks              Enable configured command hooks. Default config: .kodr/hooks.json
                       Lifecycle: PreToolUse (prevent) -> PostToolUse (audit) -> Stop (loop guard).
                       Hooks run on the host, or in the active Docker/OpenShell sandbox.
  --hooks-config PATH  Hook config path relative to the workspace.

Docker sandbox:
  --docker-sandbox     Run install/test/tool commands inside Docker.
  --docker-image IMAGE Container image for sandbox commands. Default: node:24-bookworm-slim
  --docker-network NET Container network mode. Default: none, or bridge with --install
  --docker-workdir DIR Container workspace mount path. Default: /workspace
  --docker-keep        Keep sandbox containers after commands complete.

OpenShell sandbox:
  --openshell-sandbox  Run install/test/tool commands inside OpenShell.
  --openshell-worker   Run a nested Kodr worker inside OpenShell and download artifacts only.
  --openshell-from SRC Optional OpenShell sandbox source accepted by --from.
  --openshell-policy P Explicit policy YAML. Required with --install.
  --openshell-keep     Keep the sandbox after the run for inspection.

Web channel:
  kodr serve           Start a local-only JSON HTTP channel.
                       Routes: GET /sessions, GET /sessions/:id, POST /turn

Implemented library primitives:
  workflow planning, bounded cycles, one-shot healing, ReAct tools, model comparison
`;
}

function withCliProgress(options, io) {
	if (typeof options.onProgress === 'function') {
		return options;
	}
	return {
		...options,
		onProgress(event) {
			io.stderr?.write?.(`${formatProgressEvent(event)}\n`);
		},
	};
}

export async function main(argv, io) {
	const options = parseArgs(argv, io.env);

	if (options.version) {
		io.stdout.write(`${VERSION}\n`);
		return { ok: true, command: 'version' };
	}

	if (options.help || options.command === 'help') {
		io.stdout.write(usage());
		return { ok: true, command: 'help' };
	}

	if (options.command === 'probe') {
		const result = await probe(options, io);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Probe ok\n`);
			io.stdout.write(`Run: ${result.runDir}\n`);
			io.stdout.write(`Model: ${result.model}\n`);
			io.stdout.write(`Reply: ${result.reply}\n`);
		}
		return { ok: true, command: 'probe', result };
	}

	if (options.command === 'run') {
		if (options.showSkills) {
			const skills = await discoverSkills(io.cwd);
			io.stdout.write(renderSkillIndex(skills));
			return { ok: true, command: 'run', skills };
		}

		if (options.showFiles) {
			const files = await listContextFiles(io.cwd);
			io.stdout.write(`${files.join('\n')}\n`);
			return { ok: true, command: 'run', files };
		}

		if (options.showContext) {
			const memory = await loadMemory(io.cwd);
			const prompt = await loadOptionalPrompt(options, io.cwd);
			const context = await buildWorkspaceContext(io.cwd, {
				inspection: await createInspectionContext(io.cwd, options, prompt),
				memory,
				...workspaceContextOptions(options),
			});
			io.stdout.write(renderContextMarkdown(context));
			return { ok: true, command: 'run', context };
		}

		const runOptions = options.json ? options : withCliProgress(options, io);
		if (
			Object.keys(runOptions.agentModelSpecs || {}).length > 0 &&
			!runOptions.subagentStages
		) {
			io.stderr?.write?.(
				'info: --agent-model overrides are only used with --subagent-stages\n',
			);
		}
		const result = await handleChannelRequest(
			{ kind: 'run-turn', options: runOptions },
			io,
		);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(renderRunSummary(result));
		}
		return { ok: result.ok, command: 'run', result };
	}

	if (options.command === 'tui') {
		const result = await runTui(options, io, handleChannelRequest);
		return { ok: result.ok, command: 'tui', result };
	}

	if (options.command === 'serve') {
		const instance = await startKodrServer({
			channel: handleChannelRequest,
			cwd: io.cwd,
			options,
		});
		io.stdout.write(`Serving: ${instance.url}\n`);
		await instance.closed;
		return { ok: true, command: 'serve', url: instance.url };
	}

	if (options.command === 'inspect') {
		if (options.inspectFile) {
			await jailedPath(io.cwd, options.inspectFile);
		}
		const index = await inspectWorkspace(io.cwd, {
			languages:
				options.inspectLanguages.length > 0
					? options.inspectLanguages
					: undefined,
			symbol: options.inspectSymbol,
		});
		const filteredIndex = filterInspectionIndex(index, {
			filePath: options.inspectFile,
		});
		if (options.json) {
			io.stdout.write(`${JSON.stringify(filteredIndex, null, 2)}\n`);
		} else {
			io.stdout.write(
				renderInspection(filteredIndex, {
					filePath: options.inspectFile,
					symbolName: options.inspectSymbol,
				}),
			);
		}
		return { ok: true, command: 'inspect', index: filteredIndex };
	}

	if (options.command === 'registry') {
		const results = await Promise.all(
			REGISTRY.map(async (entry) => ({
				available: await checkAvailability(entry.command),
				languages: entry.languages,
				name: entry.name,
			})),
		);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
		} else {
			for (const entry of results) {
				const mark = entry.available ? '✓' : '✗';
				const langs = entry.languages.join(',');
				io.stdout.write(`${entry.name.padEnd(36)}${langs.padEnd(24)}${mark}\n`);
			}
		}
		return { ok: true, command: 'registry', results };
	}

	if (options.command === 'replay') {
		if (!options.replayDir) {
			throw new CliError('kodr replay requires a run directory');
		}
		const replayDir = await jailedPath(io.cwd, options.replayDir);
		const result = await replayRun(replayDir.absolute);
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return { ok: true, command: 'replay', result };
	}

	if (options.command === 'cycle-review') {
		if (!options.transcriptFile) {
			throw new CliError('kodr cycle-review requires --transcript-file');
		}
		const runDir = await createRunArtifacts(io.cwd, options.out);
		const transcriptPath = await jailedPath(io.cwd, options.transcriptFile);
		const transcript = await readFile(transcriptPath.absolute, 'utf8');
		const review = await runSubagent(
			io.cwd,
			runDir,
			createCycleReviewRequest({
				transcript,
				transcriptPath: options.transcriptFile,
			}),
		);
		const result = {
			ok: review.result.ok,
			runDir,
			subagent: {
				artifactDir: review.artifactDir,
				id: review.request.id,
				kind: review.request.kind,
			},
			result: review.result,
		};
		await writeJson(join(runDir, 'summary.json'), {
			artifacts: {
				subagentRequest: 'subagents/cycle-review/request.json',
				subagentResult: 'subagents/cycle-review/result.json',
				summary: 'summary.json',
			},
			ok: result.ok,
			subagent: result.subagent,
		});
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Cycle review ok\n`);
			io.stdout.write(`Run: ${runDir}\n`);
			io.stdout.write(`Findings: ${review.result.findings.length}\n`);
		}
		return { ok: result.ok, command: 'cycle-review', result };
	}

	if (options.command === 'eval') {
		if (!options.suitePath) {
			throw new CliError('kodr eval requires --suite');
		}
		const suitePath = await jailedPath(io.cwd, options.suitePath);
		const suiteText = await readFile(suitePath.absolute, 'utf8');
		const suite = loadEvalSuite(suiteText);

		const runDir = await createRunArtifacts(io.cwd, options.out);
		const memory = await loadMemory(io.cwd);
		const context = await buildWorkspaceContext(io.cwd, {
			memory,
			...workspaceContextOptions(options),
		});

		const caseResults = [];
		for (const evalCase of suite.cases) {
			const model = evalCase.model || options.model;
			const caseOptions = { ...options, model };

			let proposal = null;
			let completionError = null;
			let finishReasons = [];
			let responseChars = 0;

			try {
				const completion = await completeWithContinuations(
					caseOptions,
					model,
					evalCase.prompt,
					context.systemPrompt,
				);
				finishReasons = completion.finishReasons;
				responseChars = completion.text.length;
				proposal = extractProposal(completion.text);
			} catch (error) {
				completionError = { message: error.message, name: error.name };
			}

			const scored = await scoreCase(evalCase, proposal, options.timeoutMs);
			caseResults.push({
				...scored,
				completionError,
				finishReasons,
				model,
				proposalFound: proposal !== null,
				responseChars,
			});
		}

		const passCount = caseResults.filter((r) => r.ok).length;
		const totalCount = caseResults.length;
		const score = totalCount > 0 ? passCount / totalCount : 1;

		const evalResults = {
			name: suite.name,
			ok: passCount === totalCount,
			score,
			cases: caseResults,
			passCount,
			totalCount,
			timestamp: new Date().toISOString(),
		};

		await writeJson(join(runDir, 'eval-results.json'), evalResults);

		if (options.json) {
			io.stdout.write(`${JSON.stringify(evalResults, null, 2)}\n`);
		} else {
			io.stdout.write(`Eval: ${suite.name}\n`);
			io.stdout.write(`Run: ${runDir}\n`);
			for (const c of caseResults) {
				const status = c.ok ? 'pass' : 'fail';
				io.stdout.write(
					`  ${c.id}: ${status} (${c.passCount}/${c.totalCount}, score ${c.score.toFixed(2)})\n`,
				);
			}
			io.stdout.write(
				`Overall: ${passCount}/${totalCount} cases passed (score ${score.toFixed(2)})\n`,
			);
		}

		return { ok: evalResults.ok, command: 'eval', evalResults, runDir };
	}

	if (options.command === 'compare') {
		if (!options.models.length) {
			throw new CliError('kodr compare requires --models');
		}
		const prompt = await loadPrompt(options, io.cwd);
		const memory = await loadMemory(io.cwd);
		const skills = await loadSkills(io.cwd, options.skills);
		const context = await buildWorkspaceContext(io.cwd, {
			memory,
			skills,
			...workspaceContextOptions(options),
		});
		const { compDir, comparison } = await runComparison(
			options,
			io.env,
			prompt,
			context.systemPrompt,
			options.models,
			io.cwd,
			options.out,
		);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
		} else {
			io.stdout.write(`Compare ok\n`);
			io.stdout.write(`Run: ${compDir}\n`);
			for (const model of comparison.models) {
				const status = model.ok ? 'ok' : 'failed';
				io.stdout.write(
					`  ${model.modelSpec}: ${status} (${model.responseChars} chars)\n`,
				);
			}
		}
		return { ok: true, command: 'compare', comparison, compDir };
	}

	if (options.command === 'prompt-history') {
		if (!options.promptHistoryId) {
			throw new CliError('kodr prompt-history requires a prompt id argument');
		}
		const runs = await scanRunHistory(io.cwd, options.promptHistoryId);
		const result = { promptId: options.promptHistoryId, runs };
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Prompt history: ${options.promptHistoryId}\n`);
			if (runs.length === 0) {
				io.stdout.write('  No runs found.\n');
			}
			for (const run of runs) {
				const status = run.ok ? 'ok' : 'fail';
				const evalPart =
					run.evalScore !== null ? ` eval=${run.evalScore.toFixed(2)}` : '';
				const tokenPart = run.tokens > 0 ? ` tokens=${run.tokens}` : '';
				io.stdout.write(
					`  ${run.timestamp}  ${run.model}  [${status}]${evalPart}${tokenPart}\n`,
				);
			}
		}
		return { ok: true, command: 'prompt-history', result };
	}

	if (options.command === 'session') {
		const sub = options.sessionSubcommand;

		if (sub === 'list') {
			const list = await handleChannelRequest(
				{ kind: 'session-list', options },
				io,
			);

			if (options.json) {
				io.stdout.write(`${JSON.stringify({ sessions: list }, null, 2)}\n`);
			} else {
				io.stdout.write(renderSessionList(list));
			}
			return {
				ok: true,
				command: 'session',
				subcommand: 'list',
				sessions: list,
			};
		}

		if (sub === 'show') {
			if (!options.sessionId) {
				throw new CliError('kodr session show requires a session id');
			}
			const conv = await handleChannelRequest(
				{ kind: 'session-show', options, sessionId: options.sessionId },
				io,
			);

			if (options.json) {
				io.stdout.write(`${JSON.stringify(conv, null, 2)}\n`);
			} else {
				io.stdout.write(renderSessionConversation(conv));
			}
			return {
				ok: true,
				command: 'session',
				subcommand: 'show',
				conversation: conv,
			};
		}

		if (sub === 'export') {
			if (!options.sessionId) {
				throw new CliError('kodr session export requires a session id');
			}
			if (options.sessionFormat !== 'markdown') {
				throw new CliError(
					'kodr session export only supports --format markdown',
				);
			}
			const conv = await handleChannelRequest(
				{ kind: 'session-show', options, sessionId: options.sessionId },
				io,
			);
			const markdown = renderSessionMarkdown(conv);
			io.stdout.write(markdown);
			return {
				ok: true,
				command: 'session',
				subcommand: 'export',
				conversation: conv,
				format: options.sessionFormat,
			};
		}

		throw new CliError(
			`kodr session requires a subcommand: list, show <id>, export <id>`,
		);
	}

	throw new CliError(`Command not implemented yet: ${options.command}`);
}

export async function handleChannelRequest(request, io) {
	if (request.kind === 'run-turn') {
		return runPrompt(request.options, io);
	}

	if (request.kind === 'permission-request') {
		return {
			decision: 'deny',
			reason: 'No interactive permission approver is available',
			request: request.request,
			status: 'denied',
		};
	}

	if (request.kind === 'permission-decision') {
		const decision = request.decision === 'allow' ? 'allow' : 'deny';
		return {
			decision,
			reason: request.reason || '',
			request: request.request,
			status: decision === 'allow' ? 'approved' : 'denied',
		};
	}

	if (request.kind === 'session-list') {
		return listSessions(io.cwd);
	}

	if (request.kind === 'session-show') {
		const conv = await loadSessionConversation(io.cwd, request.sessionId);
		if (!conv) {
			throw new CliError(`Session not found: ${request.sessionId}`);
		}
		return conv;
	}

	if (request.kind === 'inspect') {
		const filePath = request.filePath || '';
		if (filePath) {
			await jailedPath(io.cwd, filePath);
		}
		const index = await inspectWorkspace(io.cwd, {
			symbol: request.symbol || '',
		});
		return filterInspectionIndex(index, { filePath });
	}

	if (request.kind === 'verify-command') {
		if (!request.options.testCommand) {
			throw new CliError('No test command configured');
		}
		const activeExecutor = createActiveExecutor(
			io.cwd,
			join(io.cwd, '.kodr', 'verify'),
			request.options,
		);
		try {
			await initializeExecutor(activeExecutor, request.options.timeoutMs);
			return await runVerification(
				await verificationCwd(io.cwd, request.options),
				request.options.testCommand,
				{
					runner: executorCommandRunner(activeExecutor),
					timeoutMs: request.options.timeoutMs,
				},
			);
		} finally {
			await finalizeExecutor(activeExecutor, request.options.timeoutMs);
		}
	}

	throw new CliError(`Unknown channel request: ${request.kind}`);
}

async function listSessions(cwd) {
	const sessions = await scanSessions(cwd);
	const list = [];
	for (const [id, runs] of sessions) {
		const last = runs.at(-1);
		list.push({
			sessionId: id,
			turnCount: runs.length,
			model: last?.model || '',
			lastTimestamp: last?.timestamp || '',
			ok: last?.ok ?? null,
		});
	}
	list.sort((a, b) => a.lastTimestamp.localeCompare(b.lastTimestamp));
	return list;
}

export function renderSessionList(list) {
	if (list.length === 0) {
		return 'No sessions found.\n';
	}
	return `${list
		.map((session) => {
			const status =
				session.ok === null || session.ok === undefined
					? '?'
					: session.ok
						? 'ok'
						: 'fail';
			return `${session.sessionId}  turns=${session.turnCount}  [${status}]  ${session.model}`;
		})
		.join('\n')}\n`;
}

export function renderSessionConversation(conversation) {
	const lines = [`Session: ${conversation.sessionId}`];
	for (const [index, turn] of conversation.turns.entries()) {
		const status =
			turn.ok === null || turn.ok === undefined ? '?' : turn.ok ? 'ok' : 'fail';
		const tokenPart = turn.tokens > 0 ? `  tokens=${turn.tokens}` : '';
		lines.push('');
		lines.push(`Turn ${index + 1}  [${status}]  ${turn.model}${tokenPart}`);
		lines.push(
			`  User: ${turn.user.slice(0, 120)}${turn.user.length > 120 ? '…' : ''}`,
		);
		lines.push(
			`  Assistant: ${turn.assistant.slice(0, 120)}${turn.assistant.length > 120 ? '…' : ''}`,
		);
	}
	return `${lines.join('\n')}\n`;
}

export function renderSessionMarkdown(conversation) {
	const lines = [
		`# Kodr Session ${conversation.sessionId}`,
		'',
		`- Session ID: \`${conversation.sessionId}\``,
		`- Turns: ${conversation.turns.length}`,
		'',
	];

	for (const [index, turn] of conversation.turns.entries()) {
		const status =
			turn.ok === null || turn.ok === undefined ? '?' : turn.ok ? 'ok' : 'fail';
		lines.push(`## Turn ${index + 1}`);
		lines.push('');
		lines.push(`- Model: \`${turn.model}\``);
		lines.push(`- Status: ${status}`);
		if (turn.tokens > 0) {
			lines.push(`- Tokens: ${turn.tokens}`);
		}
		lines.push(`- Run: \`${turn.runDir}\``);
		lines.push('');
		lines.push('### User');
		lines.push('');
		lines.push(fencedMarkdown(turn.user));
		lines.push('');
		lines.push('### Assistant');
		lines.push('');
		lines.push(fencedMarkdown(turn.assistant));
		lines.push('');
	}

	return `${lines.join('\n')}`;
}

function fencedMarkdown(text) {
	const fence = text.includes('```') ? '````' : '```';
	return `${fence}\n${text}\n${fence}`;
}

function assignValue(options, flag, value) {
	if (flag === '--base-url') {
		options.baseUrl = value.replace(/\/+$/u, '');
		options._baseUrlSet = true;
	} else if (flag === '--completion-reserve') {
		options.completionReserve = Number(value);
		options._completionReserveSet = true;
	} else if (flag === '--context-window') {
		options.contextWindow = Number(value);
		options._contextWindowSet = true;
	} else if (flag === '--model') {
		options.model = value;
		options._modelSet = true;
	} else if (flag === '--agent-model') {
		let override;
		try {
			override = parseAgentModelOverride(value);
		} catch (error) {
			if (error instanceof ModelSpecError) {
				throw new CliError(error.message);
			}
			throw error;
		}
		options.agentModelSpecs[override.agent] = override.spec;
	} else if (flag === '--api-key') {
		options.apiKey = value;
		options._apiKeySet = true;
	} else if (flag === '--out') {
		options.out = value;
	} else if (flag === '-p' || flag === '--prompt') {
		options.prompt = value;
	} else if (flag === '--prompt-file') {
		options.promptFile = value;
	} else if (flag === '--prompt-cache') {
		options.promptCache = value;
	} else if (flag === '--prompt-id') {
		options.promptId = value;
	} else if (flag === '--session') {
		options.sessionId = value;
	} else if (flag === '--session-context-chars') {
		options.sessionContextChars = Number(value);
		options._sessionContextSet = true;
	} else if (flag === '--skill') {
		options.skills.push(value);
	} else if (flag === '--suite') {
		options.suitePath = value;
	} else if (flag === '--test') {
		options.testCommand = value;
	} else if (flag === '--test-cwd') {
		options.testCwd = value;
	} else if (flag === '--timeout-ms') {
		options.timeoutMs = Number(value);
		options._timeoutSet = true;
	} else if (flag === '--review-timeout-ms') {
		options.reviewTimeoutMs = Number(value);
	} else if (flag === '--transcript-file') {
		options.transcriptFile = value;
	} else if (flag === '--format') {
		options.sessionFormat = value;
	} else if (flag === '--docker-image') {
		options.dockerImage = value;
	} else if (flag === '--docker-network') {
		options.dockerNetwork = value;
	} else if (flag === '--docker-workdir') {
		options.dockerWorkdir = value;
	} else if (flag === '--openshell-from') {
		options.openshellFrom = value;
	} else if (flag === '--openshell-policy') {
		options.openshellPolicy = value;
	} else if (flag === '--hooks-config') {
		options.hooksConfigPath = value;
	} else if (flag === '--max-cost-usd') {
		options.maxCostUsd = value;
	} else if (flag === '--max-retries') {
		options.maxRetries = Number(value);
	} else if (flag === '--max-thinking-tokens') {
		options.maxThinkingTokens = Number(value);
	} else if (flag === '--max-tokens') {
		options.maxTokens = Number(value);
	} else if (flag === '--max-turns') {
		options.maxTurns = Number(value);
	} else if (flag === '--host') {
		options.serveHost = value;
	} else if (flag === '--port') {
		options.servePort = Number(value);
	} else if (flag === '--file') {
		options.inspectFile = value;
	} else if (flag === '--symbol') {
		options.inspectSymbol = value;
	} else if (flag === '--languages') {
		options.inspectLanguages = value
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	} else if (flag === '--prior-scratchpad') {
		options.priorScratchpadPath = value;
	}
}

async function probe(options, io) {
	const runDir = await createRunArtifacts(io.cwd);

	const modelsResponse = await listModels(options);

	await writeJson(join(runDir, 'models-response.json'), modelsResponse);

	const model = options.model || firstModelId(modelsResponse.body);
	if (!model) {
		throw new CliError(
			'No model was provided and GET /models did not return a usable model id',
		);
	}

	const chatBody = {
		messages: [
			{
				content: PROBE_PROMPT,
				role: 'user',
			},
		],
		model,
		temperature: 0,
	};

	await writeJson(join(runDir, 'chat-request.json'), {
		body: chatBody,
		url: `${options.baseUrl}/chat/completions`,
	});

	const chatResponse = await createChatCompletion(options, chatBody);

	await writeJson(join(runDir, 'chat-response.json'), chatResponse);

	const reply = firstAssistantMessage(chatResponse.body);
	if (!reply) {
		throw new CliError(
			'POST /chat/completions did not return a usable assistant message',
		);
	}

	const result = {
		baseUrl: options.baseUrl,
		model,
		modelProfile: options.modelProfile || null,
		ok: true,
		reply,
		runDir,
	};

	await writeJson(join(runDir, 'result.json'), result);
	return result;
}

async function runPrompt(options, io) {
	// Validate test command before spending tokens — a bad command would leave
	// writes on disk with no way to run the test step.
	if (options.testCommand) {
		try {
			parseVerificationCommand(options.testCommand);
		} catch (err) {
			throw new CliError(`Invalid --test command: ${err.message}`);
		}
	}

	const rawPrompt = await loadPrompt(options, io.cwd);
	const priorScratchpad = await loadPriorScratchpad(
		options.priorScratchpadPath,
		io.cwd,
	);
	const prompt = priorScratchpad
		? `${rawPrompt}\n\n## Prior scratchpad\n\n${priorScratchpad}`
		: rawPrompt;
	const promptId = resolvePromptId(options, rawPrompt);
	const runDir = await createRunArtifacts(io.cwd, options.out);
	if (options.openshellWorker) {
		try {
			const result = await runOpenShellWorker(
				io.cwd,
				runDir,
				prompt,
				options,
				io,
			);
			await writeLastRun(io.cwd, runDir);
			return {
				...result,
				promptChars: prompt.length,
				promptId,
			};
		} catch (error) {
			throw new CliError(`${error.message} Artifacts: ${runDir}`);
		}
	}
	const activeExecutor = createActiveExecutor(io.cwd, runDir, options);
	try {
		await initializeExecutor(activeExecutor, options.timeoutMs);
	} catch (error) {
		await finalizeExecutorArtifacts(runDir, activeExecutor);
		throw new CliError(
			`Sandbox initialization failed: ${error.message} Artifacts: ${runDir}`,
		);
	}
	try {
		const commandRunner = executorCommandRunner(activeExecutor);
		// When the sandbox is active, route hook commands through it so they share the
		// install/test/tool environment instead of running on the host cwd.
		const configuredHooks = await loadConfiguredHooks(io.cwd, options, {
			executor: activeExecutor ? activeExecutor.hookExecutor() : null,
		});
		const runOptions = {
			...options,
			cwd: io.cwd,
			hooks: configuredHooks.hooks,
			responseFormat: proposalResponseFormat(),
		};

		// Resolve parent session (if --continue or --session was passed).
		const parent = await resolveParentSession(options, io.cwd);

		let skills;
		let memory;
		let context;
		let initialMessages;
		let modelPrompt = prompt;
		let rawInitialMessages;
		let inspectionPlan = null;
		let sessionCompaction = null;

		if (parent) {
			// Continuation: freeze the system prompt from the parent transcript.
			// The parent raw conversation ends with the model's last reply. Append the
			// new user turn, then compact only the model-facing copy when needed.
			const parentMessages = parent.conversation;
			rawInitialMessages = [
				...parentMessages,
				{ role: 'user', content: prompt },
			];
			const evidence = await loadSessionEvidence(io.cwd, parent.sessionId);
			sessionCompaction = compactSessionConversation(rawInitialMessages, {
				budgetChars: options.sessionContextChars,
				evidence,
				sessionId: parent.sessionId,
				sourceRunDir: parent.runDir,
			});
			initialMessages = sessionCompaction.messages;
			// Build a minimal context for artifacts (context.md, workspaceFileCount).
			memory = await loadMemory(io.cwd);
			skills = await loadSkills(io.cwd, options.skills);
			const inspection = await createInspectionContext(io.cwd, options, prompt);
			if (inspection) {
				inspectionPlan = createInspectionTaskPlan(prompt, inspection.index);
			}
			context = await buildWorkspaceContext(io.cwd, {
				inspection,
				memory,
				skills,
				toolsMode: options.tools,
				...workspaceContextOptions(options),
			});
		} else {
			skills = await loadSkills(io.cwd, options.skills);
			memory = await loadMemory(io.cwd);
			const inspection = await createInspectionContext(io.cwd, options, prompt);
			if (inspection) {
				inspectionPlan = createInspectionTaskPlan(prompt, inspection.index);
			}
			modelPrompt = inspectionPlan
				? `${renderInspectionTaskPlan(inspectionPlan)}\n\n${prompt}`
				: prompt;
			context = await buildWorkspaceContext(io.cwd, {
				inspection,
				memory,
				skills,
				toolsMode: options.tools,
				...workspaceContextOptions(options),
			});
			initialMessages = [
				{ role: 'system', content: context.systemPrompt },
				{ role: 'user', content: modelPrompt },
			];
			rawInitialMessages = initialMessages;
		}

		const registry = options.tools
			? createBuiltinRegistry(io.cwd, {
					commandRunner,
					hooks: configuredHooks.hooks,
					runDir,
					skillExecutor: activeExecutor,
					timeoutMs: options.timeoutMs,
				})
			: null;
		const responsePath = join(runDir, 'response.md');
		await writeText(join(runDir, 'context.md'), renderContextMarkdown(context));
		if (inspectionPlan) {
			await writeJson(join(runDir, 'inspection-plan.json'), inspectionPlan);
		}
		await writeJson(join(runDir, 'prompt-prefix.json'), context.promptPrefix);
		await writeText(join(runDir, 'prompt.md'), prompt);

		let model;
		let completion;
		let rawRequest;

		try {
			// Only hit GET /models when no model was named. Some OpenAI-compatible
			// servers don't implement /models, and requiring it would break runs that
			// already specify --model.
			if (options.model) {
				model = options.model;
			} else {
				const modelsResponse = await listModels(options);
				model = firstModelId(modelsResponse.body);
			}

			if (!model) {
				throw new CliError(
					'No model was provided and GET /models did not return a usable model id',
				);
			}

			if (parent && model !== parent.model) {
				io.stderr.write(
					`Warning: continuing session with model ${model} (parent used ${parent.model})\n`,
				);
			}

			const rawRequestBase = {
				messages: initialMessages,
				model,
				url: `${options.baseUrl}/chat/completions`,
			};
			if (registry) {
				rawRequestBase.tools = registry.toApiTools();
			}
			const responseFormat = responseFormatForRequest(
				rawRequestBase,
				runOptions,
			);
			if (responseFormat) {
				rawRequestBase.response_format = responseFormat;
			}
			rawRequest = {
				...buildChatRequestBody(runOptions, rawRequestBase),
				url: rawRequestBase.url,
			};
			await writeJson(join(runDir, 'raw-request.json'), rawRequest);

			if (options.subagentStages && !parent) {
				const orchestrationResult = await runSubagentStages(
					io.cwd,
					runDir,
					prompt,
					{
						...runOptions,
						commandRunner,
						protectedPaths: protectedWritePaths(options),
						reviewTimeoutMs: resolveReviewTimeoutMs(options),
						skillExecutor: activeExecutor,
						skipReview: options.skipReview,
						workspaceContext: context,
					},
					io,
				);
				// Subagent stages return their own verification result. Run the same
				// bounded heal loop the standard path uses so --heal is honored here
				// too; the primary --model is the implementer, so it owns repairs.
				let testResult = orchestrationResult.testResult;
				const healingResult = await runHealingIfNeeded({
					cwd: await verificationCwd(io.cwd, options),
					commandRunner,
					model,
					options,
					registry,
					runDir,
					systemPrompt: context.systemPrompt,
					testResult,
				});
				if (healingResult?.finalVerification) {
					testResult = healingResult.finalVerification;
					await writeJson(join(runDir, 'tests.json'), testResult);
				}
				const runOk =
					!orchestrationResult.writeError &&
					!orchestrationResult.runError &&
					(!testResult || testResult.ok) &&
					(orchestrationResult.review.pass ||
						orchestrationResult.review.unavailable === true);
				let taskPlan = createTaskPlan(
					prompt,
					orchestrationResult.writeResult.writes.map((write) => write.path),
				);
				const summary = {
					applied: orchestrationResult.applied,
					applyRequested: options.yes,
					artifacts: {
						context: 'context.md',
						conversation: 'conversation.json',
						messages: 'messages.json',
						prompt: 'prompt.md',
						promptPrefix: 'prompt-prefix.json',
						rawRequest: 'raw-request.json',
						rawResponse: 'raw-response.json',
						docker: 'docker.json',
						openshell: 'openshell.json',
						hooks: 'hooks.json',
						inspectionPlan: 'inspection-plan.json',
						install: 'install.json',
						response: 'response.md',
						orchestration: 'orchestration.json',
						summary: 'summary.json',
						tasks: 'tasks.json',
						tests: 'tests.json',
						writes: 'writes.json',
					},
					baseUrl: options.baseUrl,
					contextBudget: context.contextBudget || null,
					promptPrefix: context.promptPrefix || null,
					finishReasons: orchestrationResult.finishReasons,
					loopBudget: orchestrationResult.loopBudget,
					model,
					modelProfile: options.modelProfile || null,
					ok: runOk,
					parentRunDir: null,
					promptChars: prompt.length,
					promptId,
					proposalFound: orchestrationResult.proposalFound,
					proposalStatus: orchestrationResult.proposalStatus,
					responseChars: orchestrationResult.response.length,
					responseCount: orchestrationResult.responses.length,
					review: orchestrationResult.review,
					sessionId: basename(runDir),
					subagentStages: true,
					tested: Boolean(testResult),
					timestamp: new Date().toISOString(),
					usage: usageFromBudget(orchestrationResult.loopBudget),
					verification: orchestrationResult.verification,
					workspaceFileCount: context.files.length,
					writeCount: orchestrationResult.writeCount,
				};
				if (inspectionPlan) {
					summary.inspectionPlan = inspectionPlan.inspection;
				}
				if (orchestrationResult.writeError) {
					summary.writeError = orchestrationResult.writeError;
				}
				if (orchestrationResult.runError) {
					summary.runError = orchestrationResult.runError;
				}
				if (orchestrationResult.installResult) {
					summary.installed = orchestrationResult.installResult.ok;
				}
				summary.healed = healingResult ? healingResult.healed : false;
				summary.healStopReason = healingResult?.stopReason || '';
				taskPlan = updateTasksFromRun(taskPlan, summary);
				summary.taskCounts = taskCounts(taskPlan);

				await writeText(responsePath, orchestrationResult.response);
				await writeJson(
					join(runDir, 'conversation.json'),
					orchestrationResult.messages,
				);
				await writeJson(
					join(runDir, 'messages.json'),
					orchestrationResult.proposal?.messages || [],
				);
				await writeJson(join(runDir, 'raw-response.json'), {
					loopBudget: orchestrationResult.loopBudget,
					responses: orchestrationResult.responses,
				});
				await finalizeExecutorArtifacts(runDir, activeExecutor);
				await writeHookArtifact(runDir, configuredHooks);
				await writeJson(join(runDir, 'summary.json'), summary);
				await writeJson(join(runDir, 'tasks.json'), taskPlan);
				await writeJson(
					join(runDir, 'writes.json'),
					orchestrationResult.writeResult,
				);
				await writeLastRun(io.cwd, runDir);

				return {
					...summary,
					installResult: orchestrationResult.installResult,
					proposal: orchestrationResult.proposal,
					response: orchestrationResult.response,
					responsePath,
					runDir,
					review: orchestrationResult.review,
					taskPlan,
					testResult,
					writeResult: orchestrationResult.writeResult,
				};
			}

			if (
				shouldUseStagedExecution(options, prompt, context) &&
				!parent &&
				registry
			) {
				return runStagedPrompt({
					commandRunner,
					configuredHooks,
					context,
					activeExecutor,
					io,
					memory,
					model,
					options: runOptions,
					prompt: modelPrompt,
					promptId,
					rawRequest,
					registry,
					responsePath,
					runDir,
					skills,
				});
			}

			const contOpts = parent ? { initialMessages } : {};
			const agentStartedAt = performance.now();
			const progressBase = {
				agent: 'standard',
				model,
				runDir,
			};
			emitProgress(runOptions, {
				...progressBase,
				event: 'agent_start',
				message: 'standard agent started',
			});
			await runStartHook(runOptions, 'agent_start', progressBase);
			completion = options.tools
				? await completeWithToolCalls(
						runOptions,
						model,
						modelPrompt,
						context.systemPrompt,
						registry,
						contOpts,
					)
				: await completeWithContinuations(
						runOptions,
						model,
						modelPrompt,
						context.systemPrompt,
						contOpts,
					);
			emitProgress(runOptions, {
				...progressBase,
				durationMs: Math.round(performance.now() - agentStartedAt),
				event: 'agent_finish',
				message: 'standard agent finished',
				responseChars: completion.text.length,
			});

			await writeJson(join(runDir, 'raw-request.json'), {
				...rawRequest,
				messages: completion.messages,
			});
		} catch (error) {
			await writeRunFailure(runDir, {
				baseUrl: options.baseUrl,
				context,
				error,
				initialMessages,
				model: model || options.model || '',
				modelProfile: options.modelProfile || null,
				prompt,
				promptId,
				rawRequest,
				rawRequestTools: registry ? registry.toApiTools() : null,
				responsePath,
				activeExecutor,
				configuredHooks,
			});
			throw new CliError(
				`Model run failed: ${error.message}. Artifacts: ${runDir}`,
			);
		}

		// For continuations, inherit the parent's sessionId to keep the chain
		// grouped; parentRunDir records the immediate predecessor.
		const sessionId = parent ? parent.sessionId : basename(runDir);
		const summary = {
			artifacts: {
				context: 'context.md',
				conversation: 'conversation.json',
				conversationRaw: 'conversation-raw.json',
				messages: 'messages.json',
				prompt: 'prompt.md',
				promptPrefix: 'prompt-prefix.json',
				rawRequest: 'raw-request.json',
				rawResponse: 'raw-response.json',
				docker: 'docker.json',
				openshell: 'openshell.json',
				hooks: 'hooks.json',
				inspectionPlan: 'inspection-plan.json',
				response: 'response.md',
				repairs: 'repairs/repairs.json',
				scratchpad: 'scratchpad.md',
				sessionSummary: 'session-summary.json',
				summary: 'summary.json',
				install: 'install.json',
				tasks: 'tasks.json',
				tests: 'tests.json',
				writes: 'writes.json',
			},
			baseUrl: options.baseUrl,
			contextBudget: context.contextBudget || null,
			promptPrefix: context.promptPrefix || null,
			applyRequested: options.yes,
			finishReasons: completion.finishReasons,
			loopBudget: completion.loopBudget,
			model,
			modelProfile: options.modelProfile || null,
			ok: true,
			parentRunDir: parent ? parent.runDir : null,
			promptChars: prompt.length,
			promptId,
			responseChars: completion.text.length,
			responseCount: completion.responses.length,
			sessionCompaction: sessionCompaction?.summary || null,
			sessionId,
			timestamp: new Date().toISOString(),
			usage: usageFromBudget(completion.loopBudget),
			workspaceFileCount: context.files.length,
		};
		if (inspectionPlan) {
			summary.inspectionPlan = inspectionPlan.inspection;
		}
		let proposal = null;
		let proposalError = null;
		try {
			proposal = extractProposal(completion.text);
		} catch (error) {
			proposalError = {
				message: error.message,
				name: error.name,
			};
		}

		if (proposalError) {
			let taskPlan = inspectionPlan || createTaskPlan(prompt);
			summary.applied = false;
			summary.ok = false;
			summary.proposalError = proposalError;
			summary.proposalFound = false;
			summary.tested = false;
			summary.writeCount = 0;
			taskPlan = updateTasksFromRun(taskPlan, summary);
			summary.taskCounts = taskCounts(taskPlan);

			const writeResult = {
				applied: false,
				error: proposalError,
				writes: [],
			};

			await writeText(responsePath, completion.text);
			await writeConversationArtifacts(
				runDir,
				completion.messages,
				rawInitialMessages,
				initialMessages,
				sessionCompaction,
			);
			await writeJson(join(runDir, 'messages.json'), []);
			await writeText(join(runDir, 'scratchpad.md'), '');
			await writeJson(join(runDir, 'raw-response.json'), {
				loopBudget: completion.loopBudget,
				responses: completion.responses,
			});
			await finalizeExecutorArtifacts(runDir, activeExecutor);
			await writeHookArtifact(runDir, configuredHooks);
			await writeJson(join(runDir, 'summary.json'), summary);
			await writeJson(join(runDir, 'install.json'), null);
			await writeJson(join(runDir, 'tasks.json'), taskPlan);
			await writeJson(join(runDir, 'writes.json'), writeResult);
			await writeJson(join(runDir, 'tests.json'), null);
			await writeLastRun(io.cwd, runDir);

			return {
				...summary,
				proposal: null,
				response: completion.text,
				responsePath,
				runDir,
				testResult: null,
				taskPlan,
				writeResult,
			};
		}

		const scratchpad = proposal?.scratchpad || '';
		const proposalMessages = proposal?.messages || [];
		let taskPlan =
			inspectionPlan ||
			createTaskPlan(prompt, proposal ? proposalPaths(proposal) : []);
		let writeResult = {
			applied: false,
			writes: [],
		};
		let writeError = null;
		if (!proposal && (options.yes || options.testCommand)) {
			writeError = {
				message:
					'Model response did not include a proposal, so no writes or verification were run',
				name: 'ProposalMissingError',
			};
			writeResult = {
				applied: false,
				error: writeError,
				writes: [],
			};
		} else if (proposal?.status === 'ERROR') {
			writeError = {
				message:
					proposalMessages
						.map((message) => message.content)
						.filter(Boolean)
						.join('\n') || 'Model returned status ERROR',
				name: 'ProposalStatusError',
			};
			writeResult = {
				applied: false,
				error: writeError,
				writes: [],
			};
		} else if (proposal) {
			try {
				writeResult = await prepareChanges(io.cwd, proposal, {
					apply: options.yes,
					protectExisting: options.protectExisting,
					protectedPaths: protectedWritePaths(options),
				});
			} catch (error) {
				writeError = {
					message: error.message,
					name: error.name,
				};
				writeResult = {
					applied: false,
					error: writeError,
					writes: [],
				};
			}
		}
		const installResult =
			options.installDependencies && options.yes && !writeError
				? await runDependencyInstall(await verificationCwd(io.cwd, options), {
						runner: commandRunner,
						timeoutMs: options.timeoutMs,
					})
				: null;
		const runError =
			installResult && !installResult.ok
				? {
						message: `Dependency install failed: ${installResult.command}`,
						name: 'DependencyInstallError',
					}
				: null;
		const dependencyInstallRequired = hasDependencyMetadataWrites(
			writeResult.writes,
		);
		let testResult =
			options.testCommand && options.yes && !writeError && !runError
				? await runVerification(
						await verificationCwd(io.cwd, options),
						options.testCommand,
						{
							runner: commandRunner,
							timeoutMs: options.timeoutMs,
						},
					)
				: null;
		const healingResult = await runHealingIfNeeded({
			cwd: await verificationCwd(io.cwd, options),
			commandRunner,
			model,
			options,
			registry,
			runDir,
			systemPrompt: context.systemPrompt,
			testResult,
		});
		if (healingResult?.finalVerification) {
			testResult = healingResult.finalVerification;
		}

		summary.applied = writeResult.applied;
		summary.dependencyInstallRequired = dependencyInstallRequired;
		summary.healed = healingResult ? healingResult.healed : false;
		summary.healStopReason = healingResult?.stopReason || '';
		summary.installed = installResult !== null;
		summary.ok =
			writeError || runError ? false : testResult ? testResult.ok : true;
		summary.proposalMessageCount = proposalMessages.length;
		summary.proposalFound = proposal !== null;
		summary.proposalStatus = proposal?.status || '';
		if (runError) {
			summary.runError = runError;
		}
		summary.tested = testResult !== null;
		if (writeError) {
			summary.writeError = writeError;
		}
		summary.writeCount = writeResult.writes.length;
		taskPlan = updateTasksFromRun(taskPlan, summary);
		summary.taskCounts = taskCounts(taskPlan);

		await writeText(responsePath, completion.text);
		await writeConversationArtifacts(
			runDir,
			completion.messages,
			rawInitialMessages,
			initialMessages,
			sessionCompaction,
		);
		await writeJson(join(runDir, 'messages.json'), proposalMessages);
		await writeText(join(runDir, 'scratchpad.md'), scratchpad);
		await writeJson(join(runDir, 'raw-response.json'), {
			loopBudget: completion.loopBudget,
			responses: completion.responses,
		});
		await finalizeExecutorArtifacts(runDir, activeExecutor);
		await writeHookArtifact(runDir, configuredHooks);
		await writeJson(join(runDir, 'summary.json'), summary);
		await writeJson(join(runDir, 'install.json'), installResult);
		await writeJson(join(runDir, 'tasks.json'), taskPlan);
		await writeJson(join(runDir, 'writes.json'), writeResult);
		await writeJson(join(runDir, 'tests.json'), testResult);
		await writeLastRun(io.cwd, runDir);

		return {
			...summary,
			proposal,
			response: completion.text,
			responsePath,
			runDir,
			installResult,
			healingResult,
			scratchpad,
			testResult,
			taskPlan,
			writeResult,
		};
	} finally {
		await finalizeExecutorArtifacts(runDir, activeExecutor, options.timeoutMs);
	}
}

async function runStagedPrompt({
	commandRunner,
	configuredHooks,
	context,
	activeExecutor,
	io,
	memory,
	model,
	options,
	prompt,
	promptId,
	rawRequest,
	registry,
	responsePath,
	runDir,
	skills,
}) {
	const maxStageWrites = 5;
	const maxExecutionStages = Math.max(
		1,
		Math.min(8, Number(options.maxTurns || 8) - 1),
	);
	const stageRecords = [];
	const responses = [];
	const finishReasons = [];
	const conversations = [];
	const proposalMessages = [];
	const allWrites = [];
	let scratchpad = '';
	let writeError = null;
	let runError = null;
	let lastProposal = null;
	let lastText = '';
	let done = false;
	let noProgressTurns = 0;

	const planCompletion = await completeWithToolCalls(
		options,
		model,
		`${prompt}\n\n## Kodr staged execution\nReturn a plan only. Do not include files or patches. Put a concise implementation plan in scratchpad, grouped into small stages of at most ${maxStageWrites} files each.`,
		context.systemPrompt,
		registry,
	);
	const planProposal = extractProposal(planCompletion.text);
	responses.push(...planCompletion.responses);
	finishReasons.push(...planCompletion.finishReasons);
	conversations.push(...planCompletion.messages);
	lastText = planCompletion.text;
	scratchpad = planProposal?.scratchpad || '';
	proposalMessages.push(...(planProposal?.messages || []));
	stageRecords.push({
		fileCount: planProposal ? proposalPaths(planProposal).length : 0,
		name: 'plan',
		responseChars: planCompletion.text.length,
	});

	for (let stageIndex = 1; stageIndex <= maxExecutionStages; stageIndex += 1) {
		const stageContext = await buildWorkspaceContext(io.cwd, {
			memory,
			skills,
			toolsMode: options.tools,
			...workspaceContextOptions(options),
		});
		const stagePrompt = [
			prompt,
			'',
			'## Kodr staged execution',
			`You are in implementation stage ${stageIndex} of ${maxExecutionStages}.`,
			`Implement one coherent slice only, with at most ${maxStageWrites} total file writes or patches.`,
			'The workspace does not change unless you include files or patches in this response. Do not claim a stage is complete unless this response includes the corresponding files or patches.',
			'Prefer tests and runnable support files early. If existing files need small edits, use patches instead of full rewrites.',
			'If all work is complete, return status OK with no files or patches and include a message containing STAGED_DONE.',
			noProgressTurns > 0
				? `Previous implementation turn made no file changes. Correct that now by returning 1-${maxStageWrites} files or patches.`
				: '',
			scratchpad ? `\n## Current staged plan\n${scratchpad}` : '',
		].join('\n');

		const completion = await completeWithToolCalls(
			options,
			model,
			stagePrompt,
			stageContext.systemPrompt,
			registry,
		);
		responses.push(...completion.responses);
		finishReasons.push(...completion.finishReasons);
		conversations.push(...completion.messages);
		lastText = completion.text;

		let proposal;
		try {
			proposal = extractProposal(completion.text);
		} catch (error) {
			writeError = {
				message: error.message,
				name: error.name,
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				responseChars: completion.text.length,
			});
			break;
		}

		lastProposal = proposal;
		if (!proposal) {
			writeError = {
				message: 'Staged response did not include a proposal',
				name: 'ProposalMissingError',
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				responseChars: completion.text.length,
			});
			break;
		}
		const stageMessages = proposal?.messages || [];
		proposalMessages.push(...stageMessages);
		if (proposal?.scratchpad) {
			scratchpad = proposal.scratchpad;
		}

		if (proposal?.status === 'ERROR') {
			writeError = {
				message:
					stageMessages
						.map((message) => message.content)
						.filter(Boolean)
						.join('\n') || 'Model returned status ERROR',
				name: 'ProposalStatusError',
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				responseChars: completion.text.length,
			});
			break;
		}

		const paths = proposalPaths(proposal);
		if (paths.length > maxStageWrites) {
			writeError = {
				message: `Staged proposal touched ${paths.length} paths; limit is ${maxStageWrites}`,
				name: 'StagedProposalTooLargeError',
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				paths,
				responseChars: completion.text.length,
			});
			break;
		}

		if (paths.length === 0) {
			done = stageMessages.some((message) =>
				message.content?.includes('STAGED_DONE'),
			);
			stageRecords.push({
				done,
				name: `implement-${stageIndex}`,
				noProgress: !done,
				paths,
				responseChars: completion.text.length,
			});
			if (done) {
				break;
			}
			noProgressTurns += 1;
			scratchpad = [
				scratchpad,
				`No-progress feedback: implementation stage ${stageIndex} returned no files or patches and did not include STAGED_DONE. The next stage must return concrete file or patch changes.`,
			]
				.filter(Boolean)
				.join('\n\n');
			continue;
		}

		let writeResult;
		try {
			writeResult = await prepareChanges(io.cwd, proposal, {
				apply: options.yes,
				protectExisting: options.protectExisting,
				protectedPaths: protectedWritePaths(options),
			});
		} catch (error) {
			writeError = {
				message: error.message,
				name: error.name,
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				paths,
				responseChars: completion.text.length,
			});
			break;
		}

		allWrites.push(...writeResult.writes);
		noProgressTurns = 0;
		stageRecords.push({
			applied: writeResult.applied,
			name: `implement-${stageIndex}`,
			paths,
			responseChars: completion.text.length,
			writeCount: writeResult.writes.length,
		});
	}

	const installResult =
		options.installDependencies && options.yes && !writeError
			? await runDependencyInstall(await verificationCwd(io.cwd, options), {
					runner: commandRunner,
					timeoutMs: options.timeoutMs,
				})
			: null;
	if (installResult && !installResult.ok) {
		runError = {
			message: `Dependency install failed: ${installResult.command}`,
			name: 'DependencyInstallError',
		};
	}
	const dependencyInstallRequired = hasDependencyMetadataWrites(allWrites);
	let testResult =
		options.testCommand && options.yes && !writeError && !runError
			? await runVerification(
					await verificationCwd(io.cwd, options),
					options.testCommand,
					{
						runner: commandRunner,
						timeoutMs: options.timeoutMs,
					},
				)
			: null;
	const healingResult = await runHealingIfNeeded({
		cwd: await verificationCwd(io.cwd, options),
		commandRunner,
		model,
		options,
		registry,
		runDir,
		systemPrompt: context.systemPrompt,
		testResult,
	});
	if (healingResult?.finalVerification) {
		testResult = healingResult.finalVerification;
	}
	const loopBudget = mergeLoopBudgets(responses);
	const completion = {
		finishReasons,
		loopBudget,
		messages: conversations,
		responses,
		text: lastText,
	};
	const writeResult = {
		applied: options.yes && allWrites.length > 0,
		writes: allWrites,
	};
	if (writeError) {
		writeResult.error = writeError;
	}
	if (done && !writeError && !testResult && writeResult.applied) {
		runError = {
			message:
				'Staged execution reached STAGED_DONE after applying writes, but no verification command ran. Re-run with --test or use the dependency install workflow when the project needs packages.',
			name: 'StagedUnverifiedError',
		};
	}
	const proposal = lastProposal;
	let taskPlan = createTaskPlan(
		prompt,
		allWrites.map((write) => write.path),
	);
	const summary = {
		applied: writeResult.applied,
		applyRequested: options.yes,
		artifacts: {
			context: 'context.md',
			conversation: 'conversation.json',
			messages: 'messages.json',
			prompt: 'prompt.md',
			promptPrefix: 'prompt-prefix.json',
			rawRequest: 'raw-request.json',
			rawResponse: 'raw-response.json',
			docker: 'docker.json',
			openshell: 'openshell.json',
			hooks: 'hooks.json',
			inspectionPlan: 'inspection-plan.json',
			response: 'response.md',
			repairs: 'repairs/repairs.json',
			scratchpad: 'scratchpad.md',
			summary: 'summary.json',
			install: 'install.json',
			tasks: 'tasks.json',
			tests: 'tests.json',
			writes: 'writes.json',
		},
		baseUrl: options.baseUrl,
		contextBudget: context.contextBudget || null,
		promptPrefix: context.promptPrefix || null,
		finishReasons,
		healed: healingResult ? healingResult.healed : false,
		healStopReason: healingResult?.stopReason || '',
		loopBudget,
		model,
		modelProfile: options.modelProfile || null,
		dependencyInstallRequired,
		ok: writeError || runError ? false : testResult ? testResult.ok : done,
		parentRunDir: null,
		promptChars: prompt.length,
		promptId,
		proposalFound: proposal !== null,
		proposalMessageCount: proposalMessages.length,
		proposalStatus: proposal?.status || '',
		responseChars: completion.text.length,
		responseCount: responses.length,
		installed: installResult !== null,
		runError,
		sessionId: basename(runDir),
		staged: {
			auto: options.staged === 'auto',
			done,
			maxExecutionStages,
			maxStageWrites,
			stages: stageRecords,
		},
		tested: testResult !== null,
		timestamp: new Date().toISOString(),
		usage: usageFromBudget(loopBudget),
		workspaceFileCount: context.files.length,
		writeCount: writeResult.writes.length,
	};
	if (writeError) {
		summary.writeError = writeError;
	}
	if (!runError) {
		delete summary.runError;
	}
	if (!done && !writeError && !testResult) {
		summary.writeError = {
			message:
				'Staged execution reached its stage budget without concrete changes or STAGED_DONE',
			name: 'StagedIncompleteError',
		};
		summary.ok = false;
		writeResult.error = summary.writeError;
	}
	taskPlan = updateTasksFromRun(taskPlan, summary);
	summary.taskCounts = taskCounts(taskPlan);

	await writeText(responsePath, completion.text);
	await writeJson(join(runDir, 'conversation.json'), completion.messages);
	await writeJson(join(runDir, 'messages.json'), proposalMessages);
	await writeText(join(runDir, 'scratchpad.md'), scratchpad);
	await writeJson(join(runDir, 'raw-request.json'), {
		...rawRequest,
		staged: true,
	});
	await writeJson(join(runDir, 'raw-response.json'), {
		loopBudget,
		responses,
		stages: stageRecords,
	});
	await finalizeExecutorArtifacts(runDir, activeExecutor);
	await writeHookArtifact(runDir, configuredHooks);
	await writeJson(join(runDir, 'summary.json'), summary);
	await writeJson(join(runDir, 'install.json'), installResult);
	await writeJson(join(runDir, 'tasks.json'), taskPlan);
	await writeJson(join(runDir, 'writes.json'), writeResult);
	await writeJson(join(runDir, 'tests.json'), testResult);
	await writeLastRun(io.cwd, runDir);

	return {
		...summary,
		proposal,
		response: completion.text,
		responsePath,
		runDir,
		installResult,
		healingResult,
		scratchpad,
		testResult,
		taskPlan,
		writeResult,
	};
}

function shouldUseStagedExecution(options, prompt, context) {
	if (options.staged === true) {
		return true;
	}
	if (options.staged === false || !options.tools || !options.yes) {
		return false;
	}

	const haystack = `${prompt}\n${context.agents?.content || ''}`.toLowerCase();
	const matches = [
		'postgres',
		'docker',
		'express',
		'migration',
		'package.json',
		'dependencies',
		'test',
		'api',
	].filter((term) => haystack.includes(term));
	return matches.length >= 3;
}

// Inputs Kodr feeds into a run must never be writable targets. The active
// --prompt-file is the most common foot-gun: it appears in workspace context,
// and weak models sometimes echo it back as a file to "create".
function protectedWritePaths(options) {
	return options.promptFile ? [options.promptFile] : [];
}

// The reviewer is advisory and non-fatal, so cap its wait well below the full
// model timeout unless the user overrides it. Keeps a slow or stuck local
// reviewer from tying up a run for the full --timeout-ms.
function resolveReviewTimeoutMs(options) {
	if (options.reviewTimeoutMs !== '') {
		return options.reviewTimeoutMs;
	}
	return Math.min(options.timeoutMs, DEFAULT_REVIEW_TIMEOUT_MS);
}

function workspaceContextOptions(options) {
	return {
		completionReserve: options.completionReserve,
		contextWindow: options.contextWindow,
		...(options.contextBudgetChars
			? { totalBytes: options.contextBudgetChars }
			: {}),
	};
}

async function runHealingIfNeeded({
	commandRunner,
	cwd,
	model,
	options,
	registry,
	runDir,
	systemPrompt,
	testResult,
}) {
	if (!options.heal || !options.yes || !testResult || testResult.ok) {
		return null;
	}

	const repairOptions = {
		...options,
		maxRetries: Math.min(options.maxRetries, 1),
		maxTurns: Math.min(Math.max(options.maxTurns, 1), 4),
	};

	return runSelfHealingLoop(cwd, testResult, {
		apply: true,
		artifactDir: join(runDir, 'repairs'),
		maxTurns: Math.max(1, Math.min(options.maxTurns, 3)),
		repairTurn: async ({ prompt }) => {
			const completion =
				options.tools && registry
					? await completeWithToolCalls(
							repairOptions,
							model,
							prompt,
							systemPrompt,
							registry,
						)
					: await completeWithContinuations(
							repairOptions,
							model,
							prompt,
							systemPrompt,
						);
			return {
				raw: {
					finishReasons: completion.finishReasons,
					loopBudget: completion.loopBudget,
					responses: completion.responses,
				},
				text: completion.text,
			};
		},
		testCommand: options.testCommand,
		timeoutMs: options.timeoutMs,
		turnTimeoutMs: options.timeoutMs,
		commandRunner,
	});
}

async function finalizeExecutorArtifacts(
	runDir,
	activeExecutor,
	timeoutMs = 60000,
) {
	try {
		await finalizeExecutor(activeExecutor, timeoutMs);
	} finally {
		await writeExecutorArtifacts(runDir, activeExecutor);
	}
}

function mergeLoopBudgets(responses) {
	const usage = responses.reduce(
		(total, response) => {
			const current = normalizeUsageForMerge(response.usage);
			total.promptTokens += current.promptTokens;
			total.completionTokens += current.completionTokens;
			total.tokens += current.tokens;
			total.cachedTokens += current.cachedTokens;
			total.cacheReadTokens += current.cacheReadTokens;
			total.cacheWriteTokens += current.cacheWriteTokens;
			total.cost += current.cost;
			total.costUsd += current.costUsd;
			return total;
		},
		{
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			cachedTokens: 0,
			completionTokens: 0,
			cost: 0,
			costUsd: 0,
			promptTokens: 0,
			tokens: 0,
		},
	);
	return {
		...usage,
		maxCostUsd: null,
		maxRetries: 0,
		maxTokens: null,
		maxTurns: null,
		retries: 0,
		stopReason: 'staged',
		turns: responses.length,
	};
}

function normalizeUsageForMerge(usage) {
	const promptTokens =
		usage?.prompt_tokens || usage?.promptTokens || usage?.input_tokens || 0;
	const completionTokens =
		usage?.completion_tokens ||
		usage?.completionTokens ||
		usage?.output_tokens ||
		0;
	return {
		cacheReadTokens: usage?.cacheReadTokens || 0,
		cacheWriteTokens: usage?.cacheWriteTokens || 0,
		cachedTokens: usage?.cachedTokens || 0,
		completionTokens,
		cost: usage?.cost || 0,
		costUsd: usage?.costUsd || usage?.cost_usd || 0,
		promptTokens,
		tokens:
			usage?.total_tokens || usage?.tokens || promptTokens + completionTokens,
	};
}

async function writeRunFailure(runDir, details) {
	const taskPlan = createTaskPlan(details.prompt);
	const error = serializeRunError(details.error);
	const rawRequest = details.rawRequest || {
		messages: details.initialMessages || [],
		model: details.model,
		url: `${details.baseUrl}/chat/completions`,
	};
	if (details.rawRequestTools) {
		rawRequest.tools = details.rawRequestTools;
	}
	const summary = {
		artifacts: {
			context: 'context.md',
			error: 'error.json',
			messages: 'messages.json',
			prompt: 'prompt.md',
			promptPrefix: 'prompt-prefix.json',
			rawRequest: 'raw-request.json',
			rawResponse: 'raw-response.json',
			docker: 'docker.json',
			openshell: 'openshell.json',
			hooks: 'hooks.json',
			response: 'response.md',
			scratchpad: 'scratchpad.md',
			summary: 'summary.json',
			install: 'install.json',
			tasks: 'tasks.json',
			tests: 'tests.json',
			writes: 'writes.json',
		},
		baseUrl: details.baseUrl,
		contextBudget: details.context.contextBudget || null,
		promptPrefix: details.context.promptPrefix || null,
		error,
		model: details.model,
		modelProfile: details.modelProfile || null,
		ok: false,
		parentRunDir: null,
		promptChars: details.prompt.length,
		promptId: details.promptId || '',
		rawRequestBytes: Buffer.byteLength(JSON.stringify(rawRequest)),
		responseChars: 0,
		responseCount: 0,
		sessionId: basename(runDir),
		taskCounts: taskCounts(taskPlan),
		timestamp: new Date().toISOString(),
		usage: null,
		workspaceFileCount: details.context.files.length,
	};

	await writeText(details.responsePath, '');
	await writeJson(join(runDir, 'messages.json'), []);
	await writeText(join(runDir, 'scratchpad.md'), '');
	await writeJson(join(runDir, 'error.json'), error);
	await writeJson(join(runDir, 'raw-request.json'), rawRequest);
	await writeJson(join(runDir, 'raw-response.json'), { responses: [] });
	await finalizeExecutorArtifacts(runDir, details.activeExecutor);
	await writeHookArtifact(runDir, details.configuredHooks);
	await writeJson(join(runDir, 'summary.json'), summary);
	await writeJson(join(runDir, 'install.json'), null);
	await writeJson(join(runDir, 'tasks.json'), taskPlan);
	await writeJson(join(runDir, 'tests.json'), null);
	await writeJson(join(runDir, 'writes.json'), {
		applied: false,
		writes: [],
	});
}

function serializeRunError(error) {
	const serialized = {
		message: error?.message || 'Unknown error',
		name: error?.name || 'Error',
	};
	if (error?.details && Object.keys(error.details).length > 0) {
		serialized.details = error.details;
	}
	if (error?.cause) {
		serialized.cause = serializeErrorCause(error.cause);
	}
	if (error?.stack) {
		serialized.stack = error.stack;
	}
	return serialized;
}

function serializeErrorCause(error) {
	if (!error || typeof error !== 'object') {
		return null;
	}
	const serialized = {
		message: typeof error.message === 'string' ? error.message : '',
		name: typeof error.name === 'string' ? error.name : '',
	};
	if (typeof error.code === 'string') {
		serialized.code = error.code;
	}
	if (error.cause) {
		serialized.cause = serializeErrorCause(error.cause);
	}
	return serialized;
}

async function verificationCwd(cwd, options) {
	if (!options.testCwd) {
		return cwd;
	}

	const testCwd = await jailedPath(cwd, options.testCwd);
	return testCwd.absolute;
}

async function writeConversationArtifacts(
	runDir,
	completedMessages,
	rawInitialMessages,
	sentInitialMessages,
	sessionCompaction,
) {
	const rawConversation = appendCompletionToRawConversation(
		rawInitialMessages,
		sentInitialMessages,
		completedMessages,
	);
	await writeJson(join(runDir, 'conversation.json'), completedMessages);
	await writeJson(join(runDir, 'conversation-raw.json'), rawConversation);
	await writeJson(
		join(runDir, 'session-summary.json'),
		sessionCompaction?.summary || null,
	);
}

// Resolve a parent session for --continue or --session <id>.
// Returns { conversation, model, runDir, sessionId } or null for a fresh run.
async function resolveParentSession(options, cwd) {
	const { continueSession, sessionId } = options;
	if (!continueSession && !sessionId) {
		return null;
	}

	if (continueSession && sessionId) {
		throw new CliError('--continue and --session cannot be used together');
	}

	let runDir;
	if (sessionId) {
		// Strip directory components so --session ../escape cannot traverse outside
		// .kodr/runs. Session ids are run dir basenames (timestamps), never paths.
		runDir = join(cwd, '.kodr', 'runs', basename(sessionId));
	} else {
		// --continue: read .kodr/last-run
		const lastRunPath = join(cwd, '.kodr', 'last-run');
		let lastRunText;
		try {
			lastRunText = await readFile(lastRunPath, 'utf8');
		} catch {
			throw new CliError(
				'--continue: no previous run found. Run kodr run first.',
			);
		}
		runDir = lastRunText.trim();
	}

	let summary;
	let conversation;
	try {
		summary = JSON.parse(await readFile(join(runDir, 'summary.json'), 'utf8'));
		conversation = JSON.parse(await readConversationArtifact(runDir));
	} catch {
		const which = sessionId ? `--session ${sessionId}` : '--continue';
		throw new CliError(
			`${which}: could not load conversation from ${runDir}. The run may pre-date phase 42 or have failed before writing artifacts.`,
		);
	}

	if (!Array.isArray(conversation) || conversation.length === 0) {
		throw new CliError(`Session conversation is empty or invalid in ${runDir}`);
	}

	return {
		conversation,
		model: summary.model || '',
		runDir,
		sessionId: summary.sessionId || basename(runDir),
	};
}

async function readConversationArtifact(runDir) {
	try {
		return await readFile(join(runDir, 'conversation-raw.json'), 'utf8');
	} catch {
		return readFile(join(runDir, 'conversation.json'), 'utf8');
	}
}

async function loadPrompt(options, cwd) {
	if (options.prompt && options.promptFile) {
		throw new CliError('Use either -p/--prompt or --prompt-file, not both');
	}

	if (options.prompt) {
		return options.prompt;
	}

	if (options.promptFile) {
		const promptPath = await jailedPath(cwd, options.promptFile);
		return readFile(promptPath.absolute, 'utf8');
	}

	throw new CliError('kodr run requires -p/--prompt or --prompt-file');
}

async function createInspectionContext(cwd, options, prompt) {
	if (!options.inspectContext) {
		return null;
	}
	return {
		enabled: true,
		index: await inspectWithRegistry(cwd, {
			languages:
				options.inspectLanguages.length > 0
					? options.inspectLanguages
					: undefined,
			query: prompt,
		}),
		query: prompt,
	};
}

async function loadOptionalPrompt(options, cwd) {
	if (!options.prompt && !options.promptFile) {
		return '';
	}
	return loadPrompt(options, cwd);
}

function resolvePromptId(options, prompt) {
	if (options.promptId) return options.promptId;
	if (options.promptFile) return promptIdFromFilename(options.promptFile);
	return derivePromptId(prompt);
}

// Human-readable summary for non-JSON `kodr run`. Artifacts still live in the
// run dir, but the terminal should show what actually happened — the model's
// answer or proposal, what it touched, token cost, and test outcome — not just
// "Run ok" and a path.
function renderRunSummary(result) {
	const lines = [];
	const stop = result.loopBudget?.stopReason || '';
	lines.push(
		`${result.ok ? 'Run ok' : 'Run failed'}${stop ? ` — ${stop}` : ''}`,
	);
	lines.push(`Model: ${result.model}`);

	const usageLine = renderUsageLine(result.usage);
	if (usageLine) {
		lines.push(usageLine);
	}

	if (result.proposalError) {
		lines.push('');
		lines.push(
			`No proposal extracted (${result.proposalError.name}: ${result.proposalError.message})`,
		);
		appendResponseBlock(lines, result.response);
	} else if (result.proposal) {
		const writes = result.writeResult?.writes || [];
		const mode = result.applied
			? 'applied'
			: result.applyRequested
				? 'not applied'
				: 'dry-run (no changes written)';
		lines.push('');
		lines.push(
			`Proposal: ${result.proposalStatus || 'OK'} — ${writes.length} file(s), ${mode}`,
		);
		for (const write of writes) {
			lines.push(`  ${write.status.padEnd(7)}${write.path}`);
		}

		if (result.proposal.scratchpad) {
			lines.push('');
			lines.push('Scratchpad:');
			lines.push(indentBlock(result.proposal.scratchpad));
		}

		const messages = result.proposal.messages || [];
		if (messages.length > 0) {
			lines.push('');
			lines.push('Messages:');
			for (const message of messages) {
				lines.push(`  [${message.level}] ${message.content}`);
			}
		}

		if (result.writeError) {
			lines.push('');
			lines.push(
				`Write error (${result.writeError.name}): ${result.writeError.message}`,
			);
		}

		if (result.runError) {
			lines.push('');
			lines.push(
				`Run error (${result.runError.name}): ${result.runError.message}`,
			);
		}

		// A proposal with no files and no messages is effectively a plain answer;
		// show the text so the run isn't a silent no-op.
		if (writes.length === 0 && messages.length === 0) {
			appendResponseBlock(lines, result.response);
		}
	} else {
		appendResponseBlock(lines, result.response);
	}

	if (result.testResult) {
		lines.push('');
		lines.push(
			`Tests: ${result.testResult.ok ? 'passed' : 'failed'} (${result.testResult.command})`,
		);
	}

	if (result.healingResult) {
		lines.push('');
		lines.push(
			`Repairs: ${result.healingResult.healed ? 'healed' : 'not healed'} (${result.healingResult.stopReason})`,
		);
	}

	if (result.installResult) {
		lines.push('');
		lines.push(
			`Install: ${result.installResult.ok ? 'passed' : 'failed'} (${result.installResult.command})`,
		);
	}

	const hasUnappliedWrites =
		!result.applied && (result.writeResult?.writes || []).length > 0;
	lines.push('');
	if (hasUnappliedWrites) {
		lines.push('Re-run with --yes to apply these changes.');
	}
	lines.push(`Run dir: ${result.runDir}`);
	lines.push(`Full response: ${result.responsePath}`);

	return `${lines.join('\n')}\n`;
}

function appendResponseBlock(lines, response) {
	const text = (response || '').trim();
	if (!text) {
		return;
	}
	lines.push('');
	lines.push('Response:');
	lines.push(indentBlock(text));
}

function indentBlock(text) {
	return text
		.split('\n')
		.map((line) => `  ${line}`)
		.join('\n');
}

const PRIOR_SCRATCHPAD_MAX_CHARS = 2000;

// Load prior scratchpad content from a file path or the magic "last" alias.
// Returns empty string when the path is unset, the file is missing, or the
// content is blank — so callers can always check truthiness.
async function loadPriorScratchpad(pathOrAlias, cwd) {
	if (!pathOrAlias) return '';

	let filePath =
		pathOrAlias === 'last' || pathOrAlias.startsWith('/')
			? pathOrAlias
			: join(cwd, pathOrAlias);
	if (pathOrAlias === 'last') {
		const lastRunPath = join(cwd, '.kodr', 'last-run');
		let lastRunDir;
		try {
			lastRunDir = (await readFile(lastRunPath, 'utf8')).trim();
		} catch {
			return '';
		}
		filePath = join(lastRunDir, 'scratchpad.md');
	}

	let content;
	try {
		content = (await readFile(filePath, 'utf8')).trim();
	} catch {
		return '';
	}
	if (!content) return '';

	if (content.length > PRIOR_SCRATCHPAD_MAX_CHARS) {
		content = `${content.slice(0, PRIOR_SCRATCHPAD_MAX_CHARS)}\n... (truncated)`;
	}
	return content;
}

// Write the path of the most recent successful run dir to .kodr/last-run so
// that --continue can find it without the user having to name the session.
// Only called on successful completion; failed runs (writeRunFailure) do not
// update the pointer so that --continue always resumes a usable transcript.
async function writeLastRun(cwd, runDir) {
	const kodrDir = join(cwd, '.kodr');
	await mkdir(kodrDir, { recursive: true });
	await writeFile(join(kodrDir, 'last-run'), `${runDir}\n`, 'utf8');
}

// Extract a structured usage object from a loop-budget snapshot. Returns null
// when the server sent no usage data (tokens === 0 and cost === 0).
function usageFromBudget(budget) {
	if (!budget) {
		return null;
	}
	const {
		tokens,
		promptTokens,
		completionTokens,
		cacheReadTokens = 0,
		cacheWriteTokens = 0,
		cachedTokens = 0,
		cost = 0,
		costUsd = cost,
	} = budget;
	if (
		tokens === 0 &&
		cost === 0 &&
		cacheReadTokens === 0 &&
		cacheWriteTokens === 0 &&
		cachedTokens === 0
	) {
		return null;
	}
	const result = {
		completionTokens: completionTokens ?? 0,
		cost,
		costUsd,
		promptTokens: promptTokens ?? 0,
		tokens: tokens ?? 0,
	};
	if (cacheReadTokens > 0) {
		result.cacheReadTokens = cacheReadTokens;
	}
	if (cacheWriteTokens > 0) {
		result.cacheWriteTokens = cacheWriteTokens;
	}
	if (cachedTokens > 0) {
		result.cachedTokens = cachedTokens;
	}
	return result;
}

// Format a usage object as a single human-readable line.
// e.g. "Tokens: 1,234 (prompt 900 / completion 334)  Cost: $0.0021"
function renderUsageLine(usage) {
	if (!usage) {
		return '';
	}
	const total = usage.tokens.toLocaleString();
	let line = `Tokens: ${total}`;
	const details = [];
	if (usage.promptTokens > 0) {
		details.push(`prompt ${usage.promptTokens.toLocaleString()}`);
	}
	if (usage.completionTokens > 0) {
		details.push(`completion ${usage.completionTokens.toLocaleString()}`);
	}
	if (usage.cachedTokens > 0) {
		details.push(`cached ${usage.cachedTokens.toLocaleString()}`);
	}
	if (
		usage.cacheReadTokens > 0 &&
		usage.cacheReadTokens !== usage.cachedTokens
	) {
		details.push(`cache read ${usage.cacheReadTokens.toLocaleString()}`);
	}
	if (usage.cacheWriteTokens > 0) {
		details.push(`cache write ${usage.cacheWriteTokens.toLocaleString()}`);
	}
	if (details.length > 0) {
		line += ` (${details.join(' / ')})`;
	}
	const cost = usage.cost ?? usage.costUsd ?? 0;
	if (cost > 0) {
		line += `  Cost: $${cost.toFixed(4)}`;
	}
	return line;
}

function proposalPaths(proposal) {
	return [
		...proposal.files.map((file) => file.path),
		...proposal.patches.map((patch) => patch.path),
	];
}

function hasDependencyMetadataWrites(writes) {
	return writes.some((write) =>
		/(^|\/)(package\.json|package-lock\.json)$/u.test(write.path),
	);
}
