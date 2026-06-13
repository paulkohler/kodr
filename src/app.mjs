import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
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
import { createPermissionRequest } from './tools.mjs';
import {
	buildCommitMessage,
	commitAppliedWrites,
	gitTreeState,
} from './git-workspace.mjs';
import { undoLastApply } from './undo.mjs';
import {
	discoverSkills,
	discoverSkillsTiered,
	loadSkills,
	renderSkillIndex,
} from './skills.mjs';
import {
	AgentError,
	discoverAgents,
	findAgent,
	isOrchestrationRole,
	parseAgentMarkdown,
} from './agents.mjs';
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
import {
	completeWithToolCalls,
	createBuiltinRegistry,
	mergeProposalWithDraft,
} from './tool-calls.mjs';
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
import {
	normalizeEditFormat,
	extractEditBlocks,
	mergeBlockPatches,
} from './edit-formats.mjs';
import { captureEnvironmentFacts } from './system-env.mjs';
import { applyModelProfileDefaults } from './model-profiles.mjs';
import {
	applyProjectConfig,
	defaultConfigPath,
	loadProjectConfig,
	ProjectConfigError,
	renderShowConfig,
} from './project-config.mjs';
import { isWorkspaceCase, loadEvalSuite, scoreCase } from './eval.mjs';
import {
	recordResults,
	runWorkspaceCase,
	runWorkspaceSuite,
	slugify,
} from './eval-runner.mjs';
import { startKodrServer } from './server.mjs';
import { inspectWorkspace } from './repomap/index.mjs';
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
import { buildHarnessManifest } from './harness.mjs';
import { runPostWriteDiagnostics } from './post-write-sensor.mjs';
import {
	computeRoutingTable,
	discoverModels,
	loadBenchScores,
	renderBenchResults,
	saveBenchScores,
	saveRoutingTable,
} from './bench.mjs';
import {
	buildCausalStory,
	loadRunAnalysis,
	renderForensicsCli,
	resolveRunDir,
} from './forensics.mjs';

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

export function parseArgs(argv, env = {}, cwd = process.cwd()) {
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
		editFormat: 'patch',
		extraHeaders: {},
		force: false,
		gitCommit: false,
		help: false,
		heal: 'auto',
		enableHooks: false,
		agentModels: {},
		agentModelSpecs: {},
		hooksConfigPath: '',
		inspectFile: '',
		inspectSymbol: '',
		inspectLanguages: [],
		inspectContext: 'auto',
		lsp: 'auto',
		installDependencies: false,
		json: false,
		model: env.MODEL_ID || DEFAULT_MODEL_ID,
		out: '',
		apiKey: env.OPENAI_API_KEY || '',
		prompt: '',
		promptCache: 'auto',
		promptFile: '',
		protectExisting: false,
		provider: 'local',
		replayDir: '',
		agent: '',
		agentsDirs: [],
		showConfig: false,
		showContext: false,
		showFiles: false,
		showSkills: false,
		skillsDirs: [],
		skills: [],
		stream: 'auto',
		wireNoStream: false,
		firstTokenTimeoutMs: '',
		suitePath: '',
		record: false,
		evalCases: [],
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
		serveMaxActiveRuns: 1,
		servePort: DEFAULT_SERVE_PORT,
		staged: 'auto',
		subagentStages: false,
		skipReview: false,
		repairTimeoutMs: '',
		reviewTimeoutMs: '',
		tools: 'auto',
		testCwd: '',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		transcriptFile: '',
		maxCostUsd: '',
		maxRetries: 7,
		maxThinkingTokens: '',
		maxTokens: '',
		maxTurns: 8,
		patchRetries: 2,
		version: false,
		yes: false,
		_apiKeySet: false,
		_baseUrlSet: false,
		_dryRunSet: false,
		_editFormatSet: false,
		_baseUrlEnvSet: Boolean(env.BASE_URL),
		_completionReserveSet: false,
		_contextWindowSet: false,
		_healSet: false,
		_inspectContextSet: false,
		_lspSet: false,
		_maxCostUsdSet: false,
		_maxRetriesSet: false,
		_maxTokensSet: false,
		_maxTurnsSet: false,
		_modelSet: false,
		_patchRetriesSet: false,
		_modelEnvSet: Boolean(env.MODEL_ID),
		_protectExistingSet: false,
		_sessionContextSet: false,
		_firstTokenTimeoutSet: false,
		_streamSet: false,
		_testCommandSet: false,
		_testCwdSet: false,
		_timeoutSet: false,
		_toolsSet: false,
		_skillsDirsSet: false,
		_agentsDirsSet: false,
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
			options._dryRunSet = true;
			continue;
		}

		if (arg === '--yes') {
			options.dryRun = false;
			options.yes = true;
			continue;
		}

		if (arg === '--protect-existing') {
			options.protectExisting = true;
			options._protectExistingSet = true;
			continue;
		}

		if (arg === '--show-config') {
			options.showConfig = true;
			continue;
		}

		if (arg === '--show-context') {
			options.showContext = true;
			continue;
		}

		if (arg === '--force') {
			options.force = true;
			continue;
		}

		if (arg === '--inspect-context') {
			options.inspectContext = true;
			options._inspectContextSet = true;
			continue;
		}

		if (arg === '--no-inspect-context') {
			options.inspectContext = false;
			options._inspectContextSet = true;
			continue;
		}

		if (arg === '--lsp') {
			options.lsp = true;
			options._lspSet = true;
			continue;
		}

		if (arg === '--no-lsp') {
			options.lsp = false;
			options._lspSet = true;
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
			options._streamSet = true;
			continue;
		}

		if (arg === '--no-stream') {
			options.stream = false;
			options._streamSet = true;
			continue;
		}

		if (arg === '--wire-no-stream') {
			options.wireNoStream = true;
			continue;
		}

		if (arg === '--first-token-timeout-ms') {
			options.firstTokenTimeoutMs = Number(argv[++index]);
			options._firstTokenTimeoutSet = true;
			continue;
		}

		if (arg === '--openrouter') {
			options.provider = 'openrouter';
			continue;
		}

		if (arg === '--tools') {
			options.tools = true;
			options._toolsSet = true;
			continue;
		}

		if (arg === '--no-tools') {
			options.tools = false;
			options._toolsSet = true;
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

		if (arg === '--no-patch-retries') {
			options.patchRetries = 0;
			options._patchRetriesSet = true;
			continue;
		}

		if (arg === '--heal') {
			options.heal = true;
			options._healSet = true;
			continue;
		}

		if (arg === '--no-heal') {
			options.heal = false;
			options._healSet = true;
			continue;
		}

		if (arg === '--commit') {
			options.gitCommit = true;
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

		if (arg === '--record') {
			options.record = true;
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

		if (arg === '--cases') {
			if (index + 1 >= argv.length) {
				throw new CliError(`${arg} requires a value`);
			}
			const value = argv[index + 1];
			index += 1;
			options.evalCases = value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			continue;
		}

		if (arg === '--skills-dir' || arg === '--agents-dir') {
			if (index + 1 >= argv.length) {
				throw new CliError(`${arg} requires a value`);
			}
			const value = argv[index + 1];
			index += 1;
			if (arg === '--skills-dir') {
				options.skillsDirs.push(value);
				options._skillsDirsSet = true;
			} else {
				options.agentsDirs.push(value);
				options._agentsDirsSet = true;
			}
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
			arg === '--agent' ||
			arg === '--skill' ||
			arg === '--suite' ||
			arg === '--test' ||
			arg === '--test-cwd' ||
			arg === '--timeout-ms' ||
			arg === '--repair-timeout-ms' ||
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
			arg === '--max-active-runs' ||
			arg === '--file' ||
			arg === '--symbol' ||
			arg === '--languages' ||
			arg === '--patch-retries' ||
			arg === '--prior-scratchpad' ||
			arg === '--edit-format'
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
		} else if (options.command === 'why' && positionals.length === 2) {
			options.whyRunId = positionals[1];
		} else if (positionals.length > 1) {
			throw new CliError(
				`Unexpected positional arguments: ${positionals.slice(1).join(' ')}`,
			);
		}
	}

	// Build source map before applying project config so sentinels reflect only
	// what was set by CLI flags and environment variables.
	const configSources = {
		model: options._modelSet
			? 'flag'
			: options._modelEnvSet
				? 'env'
				: 'builtin',
		baseUrl: options._baseUrlSet
			? 'flag'
			: options._baseUrlEnvSet
				? 'env'
				: 'builtin',
		timeoutMs: options._timeoutSet ? 'flag' : 'builtin',
		maxTurns: options._maxTurnsSet ? 'flag' : 'builtin',
		maxRetries: options._maxRetriesSet ? 'flag' : 'builtin',
		tools: options._toolsSet ? 'flag' : 'builtin',
		stream: options._streamSet ? 'flag' : 'builtin',
		heal: options._healSet ? 'flag' : 'builtin',
		inspectContext: options._inspectContextSet ? 'flag' : 'builtin',
		lsp: options._lspSet ? 'flag' : 'builtin',
		testCommand: options._testCommandSet ? 'flag' : 'builtin',
		testCwd: options._testCwdSet ? 'flag' : 'builtin',
		maxTokens: options._maxTokensSet ? 'flag' : 'builtin',
		maxCostUsd: options._maxCostUsdSet ? 'flag' : 'builtin',
		protectExisting: options._protectExistingSet ? 'flag' : 'builtin',
	};

	let loadedProjectConfig;
	try {
		loadedProjectConfig = loadProjectConfig(cwd, env);
	} catch (error) {
		if (error instanceof ProjectConfigError) {
			throw new CliError(error.message);
		}
		throw error;
	}
	const configApplied = applyProjectConfig(options, loadedProjectConfig);
	for (const key of configApplied) {
		configSources[key] = 'config';
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
		const agentModelEntries = Object.entries(
			resolveAgentModels(options, env),
		).map(([agent, modelOptions]) => [
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
		]);
		options.agentModels = Object.fromEntries(agentModelEntries);
	} catch (error) {
		if (error instanceof ModelSpecError) {
			throw new CliError(error.message);
		}
		throw error;
	}
	// timeoutMs source: if not from flag or config, it came from the profile.
	if (configSources.timeoutMs === 'builtin') {
		configSources.timeoutMs = 'profile';
	}
	// tools source: if not from flag or config, it was auto-resolved from the profile.
	if (configSources.tools === 'builtin') {
		configSources.tools = 'profile';
	}
	options.configSources = configSources;

	// Preserve a non-sentinel flag so runPrompt can tell if the user explicitly
	// set --model (agent model spec only applies when model was not explicitly set).
	options.modelExplicit = Boolean(
		configSources.model === 'flag' || configSources.model === 'env',
	);

	delete options._apiKeySet;
	delete options._baseUrlEnvSet;
	delete options._baseUrlSet;
	delete options._completionReserveSet;
	delete options._contextWindowSet;
	delete options._healSet;
	delete options._inspectContextSet;
	delete options._lspSet;
	delete options._maxCostUsdSet;
	delete options._maxRetriesSet;
	delete options._maxTokensSet;
	delete options._maxTurnsSet;
	delete options._modelEnvSet;
	delete options._modelSet;
	delete options._protectExistingSet;
	delete options._sessionContextSet;
	delete options._streamSet;
	delete options._testCommandSet;
	delete options._testCwdSet;
	delete options._timeoutSet;
	delete options._toolsSet;
	delete options._skillsDirsSet;
	delete options._agentsDirsSet;

	if (options.dockerSandbox) {
		Object.assign(options, dockerDefaults(options));
	}
	if (options.openshellSandbox || options.openshellWorker) {
		Object.assign(options, openshellDefaults(options));
	}
	if (options.subagentStages) {
		options.tools = true;
	}

	if (options.gitCommit && !options.yes) {
		throw new CliError(
			'--commit requires --yes; nothing is committed on a dry-run',
		);
	}

	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
		throw new CliError(
			'--timeout-ms must be an integer greater than or equal to 100',
		);
	}
	validateContextBudgetOptions(options);
	if (
		options.repairTimeoutMs !== '' &&
		(!Number.isInteger(options.repairTimeoutMs) ||
			options.repairTimeoutMs < 100)
	) {
		throw new CliError(
			'--repair-timeout-ms must be an integer greater than or equal to 100',
		);
	}
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
	if (
		!Number.isInteger(options.serveMaxActiveRuns) ||
		options.serveMaxActiveRuns < 1 ||
		options.serveMaxActiveRuns > 8
	) {
		throw new CliError('--max-active-runs must be an integer from 1 to 8');
	}
}

export function usage() {
	return `kodr ${VERSION}

Usage:
  kodr --help
  kodr --version
  kodr probe [--json]
  kodr init [--force]
  kodr run -p "task" [--json]
  kodr run --prompt-file prompt.md [--out .kodr/runs/name] [--prompt-id slug]
  kodr run -p "task" --dry-run
  kodr run -p "task"              # TTY: prompts apply? [y/N] before writing
  kodr run -p "task" --yes [--install] [--test "npm test"] [--test-cwd path] [--heal]
  kodr run -p "task" --yes --commit
  kodr undo [--json]
  kodr run -p "task" --yes --docker-sandbox [--docker-keep] [--test "npm test"]
  kodr run -p "task" --yes --openshell-sandbox [--openshell-keep] [--test "npm test"]
  kodr run --prompt-file prompt.md --openshell-worker --yes [--install] [--test "npm test"]
  kodr run -p "task" [--no-tools] [--no-stream] [--wire-no-stream] [--no-heal] [--no-inspect-context]
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
  kodr serve [--host 127.0.0.1] [--port 8787] [--max-active-runs 1]
  kodr inspect [--symbol name] [--file path] [--json]
  kodr registry [--json]
  kodr run --show-files
  kodr run --show-context
  kodr run --show-skills
  kodr run --show-config
  kodr cycle-review --transcript-file chat.md [--json]
  kodr compare -p "task" --models "m1,openrouter:m2" [--json]
  kodr eval --suite evals/suite.json [--json] [--record] [--cases id1,id2]
  kodr bench --suite evals/suite.json [--base-url URL] [--json]
  kodr prompt-history <promptId> [--json]
  kodr session list [--json]
  kodr session show <sessionId> [--json]
  kodr session export <sessionId> --format markdown
  kodr replay <run-dir>
  kodr watch --test "npm test"

Project config:
  kodr init             Write a starter .kodr/config.json with the currently
                        resolved model, base URL, and (when package.json has a
                        test script) testCommand: "npm test".
  --force               Overwrite existing .kodr/config.json (init only).
  .kodr/config.json     Per-project defaults. Precedence (highest first):
                          CLI flags > env vars > project config > model profile > built-in defaults
                        Allowed keys: model, baseUrl, editFormat, testCommand, testCwd, tools,
                          stream, heal, inspectContext, lsp, timeoutMs, maxTurns, maxRetries,
                          maxTokens, maxCostUsd, protectExisting
                        Gate keys rejected: yes, gitCommit, installDependencies,
                          enableHooks, apiKey
                        Keys named "//" are comment keys and are silently skipped.
                        Override the path with KODR_CONFIG env var.
  kodr run --show-config
                        Print each resolved config option with its source
                        (flag / env / config / profile / builtin) and exit.

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
  --record             Append results to evals/results/<suite>/<model>.jsonl.
  --cases id1,id2      Comma-separated case IDs to run (default: all).
  --prior-scratchpad   Path to a scratchpad file to inject into the user message.
                       Use "last" to read from the most recent run's scratchpad.
                       Truncated to 2000 characters. Skipped if empty.
  --edit-format <whole|patch|blocks>
                       How the model formats file edits. Default: patch.
                         patch  — JSON patches/files envelope (default)
                         whole  — full-file rewrites in the JSON envelope
                         blocks — SEARCH/REPLACE blocks outside JSON (no json_schema)
  --staged             Force plan-first staged execution for complex work.
  --no-staged          Disable automatic staged execution.
  --subagent-stages    Run planner, implementer, and reviewer as isolated tool agents.
  --no-review          Skip the advisory reviewer stage in --subagent-stages runs.
  --wire-no-stream     Disable SSE streaming on the wire (debug only — servers that
                       cannot stream). Never chosen automatically; use --no-stream
                       to suppress display rendering instead.
  --first-token-timeout-ms N
                       Abort and retry if no first SSE chunk arrives within N ms.
                       Default: 120000 (120s). Also configurable per model profile.
  --repair-timeout-ms N  Per-turn repair model timeout. Default: min(--timeout-ms, 240000).
  --review-timeout-ms N  Reviewer model timeout. Default: min(--timeout-ms, ${DEFAULT_REVIEW_TIMEOUT_MS}).
  --install            Run controlled dependency install after applied writes.
                       Uses npm ci when package-lock.json exists, otherwise npm install.
  --heal               After failed verification, run a bounded repair loop.
                       Default: auto (on when --yes and --test are both set).
  --no-heal            Disable automatic healing even when --yes and --test are set.
  --lsp                Enable LSP enrichment (run all available LSP servers on PATH).
  --no-lsp             Disable LSP enrichment.
                       Default: auto (use any LSP server found on PATH; skip silently
                       if none are available).
  --commit             After a clean apply (and passing tests when --test is set),
                       git-commit exactly the applied files with a run-referencing
                       message. Requires --yes. Git use is allowlisted; no push.
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

Undo:
  kodr undo            Revert the last applied run using its write manifest and
                       safe-write backups. Refuses when applied files were edited
                       after the apply. Works in git and non-git workspaces.

Watch mode:
  kodr watch --test CMD
                       Watch for file changes and run CMD on each change.
                       On failure, propose a repair as a pending review —
                       never auto-applies. --test accepts the same allowlisted
                       commands as --heal (npm test, node --test, etc.).
                       Ctrl+C or SIGTERM stops the loop.

Web channel:
  kodr serve           Start a local-only JSON HTTP control plane.
                       Async runs: POST /runs, GET /runs(/:id), GET /runs/:id/events (SSE),
                       GET /runs/:id/logs, GET /runs/:id/artifacts(/:name), POST /runs/:id/cancel
                       Sessions: GET /sessions(/:id), POST /sessions/:id/turns
                       Inspection: GET /health, GET /status. Compatibility: POST /turn
  --max-active-runs N  Concurrent active HTTP runs (default 1; queued otherwise).

Implemented library primitives:
  workflow planning, bounded cycles, one-shot healing, ReAct tools, model comparison
`;
}

// Commit exactly the proposal-applied files when --commit was requested and
// the run is in a committable state: writes applied, no run errors, and tests
// (when run) passing. Returns null when --commit was not requested, otherwise
// an honest record of what happened for git.json and the run summary.
async function maybeCommitAppliedWrites(cwd, options, state) {
	if (!options.gitCommit) {
		return null;
	}
	if (!state.writeResult.applied || state.writeError || state.runError) {
		return {
			committed: false,
			error: 'Skipped: no writes were applied cleanly, nothing to commit',
		};
	}
	if (state.testResult && !state.testResult.ok) {
		return {
			committed: false,
			error: 'Skipped: verification failed; refusing to commit a broken state',
		};
	}
	return commitAppliedWrites(cwd, {
		files: state.writeResult.writes.map((write) => write.path),
		message: buildCommitMessage({
			prompt: state.prompt,
			runId: basename(state.runDir),
		}),
	});
}

async function runInit(options, io) {
	const configPath = defaultConfigPath(io.cwd, io.env || {});

	let exists = false;
	try {
		await readFile(configPath, 'utf8');
		exists = true;
	} catch {
		exists = false;
	}

	if (exists && !options.force) {
		throw new CliError(
			`${configPath} already exists — use kodr init --force to overwrite`,
		);
	}

	let testCommand = null;
	try {
		const pkg = JSON.parse(
			await readFile(join(io.cwd, 'package.json'), 'utf8'),
		);
		if (pkg?.scripts?.test) testCommand = 'npm test';
	} catch {
		// No package.json or no test script — omit testCommand from starter.
	}

	const config = {
		'//':
			'kodr project config — see `kodr --help` and usage.md. ' +
			'Gate keys (yes, gitCommit, installDependencies, enableHooks, apiKey) are not allowed.',
		model: options.model,
		baseUrl: options.baseUrl,
	};
	if (testCommand) {
		config.testCommand = testCommand;
	}

	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

	return {
		configPath,
		model: options.model,
		baseUrl: options.baseUrl,
		testCommand,
	};
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

function makeCliApplyApprover(io) {
	return async function cliApplyApprover(request) {
		if (request.action !== 'apply-writes') {
			return { decision: 'deny', reason: 'Approver only handles apply-writes' };
		}
		const writes = request.input?.writes || [];
		const messages = request.input?.messages || [];
		io.stdout.write('\nProposed writes:\n');
		for (const write of writes) {
			io.stdout.write(
				`  ${(write.status || 'write').padEnd(7)}${write.path}\n`,
			);
		}
		if (messages.length > 0) {
			io.stdout.write('Messages:\n');
			for (const message of messages) {
				io.stdout.write(`  [${message.level}] ${message.content}\n`);
			}
		}
		io.stdout.write('apply? [y/N] ');
		const rl = createInterface({
			input: io.stdin,
			output: io.stdout,
			terminal: false,
		});
		let answer = '';
		try {
			// Async iterator handles EOF cleanly: ends the loop with answer = ''.
			for await (const line of rl) {
				answer = line;
				break;
			}
		} catch {
			// Error reading — treat as decline.
		} finally {
			rl.close();
		}
		const accepted = /^y(?:es)?$/iu.test(answer.trim());
		return accepted
			? { decision: 'allow', reason: 'accepted' }
			: { decision: 'deny', reason: 'declined' };
	};
}

export async function main(argv, io) {
	const options = parseArgs(argv, io.env, io.cwd || process.cwd());

	// Resolve 'auto' stream: display rendering only — on for interactive TTY
	// non-json runs, off otherwise. This does NOT affect the wire protocol;
	// createChatCompletion always streams on the wire unless --wire-no-stream
	// is passed explicitly.
	if (options.stream === 'auto') {
		options.stream = io.stdout.isTTY === true && !options.json;
		if (options.configSources) {
			options.configSources.stream = 'auto';
		}
	}

	if (options.version) {
		io.stdout.write(`${VERSION}\n`);
		return { ok: true, command: 'version' };
	}

	if (options.help || options.command === 'help') {
		io.stdout.write(usage());
		return { ok: true, command: 'help' };
	}

	if (options.command === 'skills') {
		const { skills, shadows } = await discoverSkillsTiered(io.cwd, {
			skillsDirs: resolvedSkillsDirs(options, io.cwd),
		});
		const { agents, shadows: agentShadows } = await discoverAgents(io.cwd, {
			agentsDirs: resolvedAgentsDirs(options, io.cwd),
		});
		if (options.json) {
			io.stdout.write(
				`${JSON.stringify(
					{
						skills: skills.map((s) => ({
							name: s.name,
							description: s.description,
							path: s.path,
							tier: s.tier,
							absoluteRoot: s.absoluteRoot,
						})),
						agents: agents.map((a) => ({
							name: a.name,
							description: a.description,
							sourcePath: a.sourcePath,
							tier: a.tier,
							modelSpec: a.modelSpec,
							modelAlias: a.modelAlias,
						})),
						shadows,
						agentShadows,
					},
					null,
					2,
				)}\n`,
			);
		} else {
			io.stdout.write(
				renderSkillsListing({ skills, shadows, agents, agentShadows }),
			);
		}
		return {
			ok: true,
			command: 'skills',
			skills,
			agents,
			shadows,
			agentShadows,
		};
	}

	if (options.command === 'probe') {
		const result = await probe(options, io);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Probe ok\n`);
			io.stdout.write(`Run: ${result.runDir}\n`);
			io.stdout.write(`Model: ${result.model}\n`);
			io.stdout.write(`Structured output: ${result.structuredOutputMode}\n`);
			io.stdout.write(`Reply: ${result.reply}\n`);
		}
		return { ok: true, command: 'probe', result };
	}

	if (options.command === 'init') {
		const result = await runInit(options, io);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Wrote ${result.configPath}\n`);
		}
		return { ok: true, command: 'init', result };
	}

	if (options.command === 'run') {
		if (options.showConfig) {
			io.stdout.write(renderShowConfig(options));
			return { ok: true, command: 'run', configSources: options.configSources };
		}

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
			const inspectionResult = await createInspectionContext(
				io.cwd,
				options,
				prompt,
			);
			const inspection = inspectionResult?.enabled ? inspectionResult : null;
			const context = await buildWorkspaceContext(io.cwd, {
				inspection,
				memory,
				...workspaceContextOptions(options),
			});
			io.stdout.write(renderContextMarkdown(context));
			return { ok: true, command: 'run', context };
		}

		const runOptions = options.json ? options : withCliProgress(options, io);
		// Wire chunk renderer for interactive one-shot streaming (TTY, non-json).
		if (
			options.stream &&
			!options.json &&
			typeof runOptions.onStreamContent !== 'function'
		) {
			runOptions.onStreamContent = (chunk) => {
				io.stdout.write(chunk);
			};
		}
		if (
			Object.keys(runOptions.agentModelSpecs || {}).length > 0 &&
			!runOptions.subagentStages
		) {
			io.stderr?.write?.(
				'info: --agent-model overrides are only used with --subagent-stages\n',
			);
		}
		// Inject an interactive apply approver for TTY CLI runs unless the user
		// passed --yes, --dry-run, or --json.
		if (
			io.stdin?.isTTY &&
			io.stdout?.isTTY &&
			!options.json &&
			!options.yes &&
			!options._dryRunSet
		) {
			runOptions.applyApprover = makeCliApplyApprover(io);
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
		const suiteDir = dirname(suitePath.absolute);

		const filterIds =
			options.evalCases.length > 0 ? new Set(options.evalCases) : null;

		const runDir = await createRunArtifacts(io.cwd, options.out);
		const memory = await loadMemory(io.cwd);
		const context = await buildWorkspaceContext(io.cwd, {
			memory,
			...workspaceContextOptions(options),
		});

		const caseResults = [];

		for (const evalCase of suite.cases) {
			if (filterIds && !filterIds.has(evalCase.id)) continue;

			if (isWorkspaceCase(evalCase)) {
				// Workspace case: run through the real pipeline in a staged fixture dir
				const workspaceOptions = {
					...options,
					_runPrompt: runPrompt,
				};
				const result = await runWorkspaceCase(
					evalCase,
					suiteDir,
					workspaceOptions,
					io,
					runDir,
				);
				caseResults.push(result);

				if (!options.json) {
					const status =
						result.status === 'skipped'
							? `skip (${result.reason})`
							: result.status === 'fixture-invalid'
								? `fixture-invalid`
								: result.ok
									? 'pass'
									: 'fail';
					const score =
						result.score !== undefined && result.score !== null
							? ` (score ${result.score.toFixed(2)})`
							: '';
					io.stdout.write(`  ${result.id}: ${status}${score}\n`);
				}
			} else {
				// Proposal case: existing completion-only path
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
				const result = {
					...scored,
					completionError,
					finishReasons,
					model,
					proposalFound: proposal !== null,
					responseChars,
					status: 'ran',
				};
				caseResults.push(result);

				if (!options.json) {
					const status = result.ok ? 'pass' : 'fail';
					io.stdout.write(
						`  ${result.id}: ${status} (${result.passCount}/${result.totalCount}, score ${result.score.toFixed(2)})\n`,
					);
				}
			}
		}

		// Score over non-skipped, non-fixture-invalid cases
		const scoredResults = caseResults.filter((r) => r.status === 'ran');
		const skippedResults = caseResults.filter(
			(r) => r.status === 'skipped' || r.status === 'fixture-invalid',
		);
		const passCount = scoredResults.filter((r) => r.ok).length;
		const totalCount = scoredResults.length;
		const score = totalCount > 0 ? passCount / totalCount : 1;

		const evalResults = {
			name: suite.name,
			ok: passCount === totalCount && skippedResults.length === 0,
			score,
			cases: caseResults,
			passCount,
			totalCount,
			skippedCount: skippedResults.length,
			timestamp: new Date().toISOString(),
		};

		await writeJson(join(runDir, 'eval-results.json'), evalResults);

		if (options.record) {
			const promptIds = new Map();
			for (const evalCase of suite.cases) {
				promptIds.set(evalCase.id, derivePromptId(evalCase.prompt));
			}
			await recordResults(
				io.cwd,
				suite.name,
				options.model,
				caseResults,
				promptIds,
			);
		}

		if (options.json) {
			io.stdout.write(`${JSON.stringify(evalResults, null, 2)}\n`);
		} else {
			io.stdout.write(`Eval: ${suite.name}\n`);
			io.stdout.write(`Run: ${runDir}\n`);
			if (skippedResults.length > 0) {
				for (const c of skippedResults) {
					io.stdout.write(`  ${c.id}: ${c.status} — ${c.reason || ''}\n`);
				}
			}
			io.stdout.write(
				`Overall: ${passCount}/${totalCount} cases passed (score ${score.toFixed(2)})`,
			);
			if (skippedResults.length > 0) {
				io.stdout.write(`, ${skippedResults.length} skipped/invalid`);
			}
			io.stdout.write('\n');
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

	if (options.command === 'undo') {
		const result = await handleChannelRequest(
			{ kind: 'undo-run', options },
			io,
		);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`${result.message}\n`);
			for (const file of result.files || []) {
				io.stdout.write(`  ${file.action.padEnd(8)}${file.path}\n`);
			}
			for (const conflict of result.conflicts || []) {
				io.stdout.write(`  conflict ${conflict.path}: ${conflict.reason}\n`);
			}
		}
		return { ok: result.ok, command: 'undo', result };
	}

	if (options.command === 'bench') {
		if (!options.suitePath) {
			throw new CliError('kodr bench requires --suite');
		}
		const suitePath = await jailedPath(io.cwd, options.suitePath);
		const suiteText = await readFile(suitePath.absolute, 'utf8');
		const suite = loadEvalSuite(suiteText);
		const suiteDir = dirname(suitePath.absolute);

		const models = await discoverModels(options.baseUrl, options.timeoutMs);
		if (models.length === 0) {
			throw new CliError(
				`No models found at ${options.baseUrl}. Is LM Studio running?`,
			);
		}

		if (!options.json) {
			io.stdout.write(`Bench: ${suite.name}\n`);
			io.stdout.write(`Models: ${models.join(', ')}\n`);
		}

		const runDir = await createRunArtifacts(io.cwd, options.out);
		const existingScores = await loadBenchScores(io.cwd);

		for (const modelId of models) {
			if (!options.json) {
				io.stdout.write(`\nRunning suite against: ${modelId}\n`);
			}
			const modelOptions = {
				...options,
				model: modelId,
				_runPrompt: runPrompt,
			};

			const caseResults = await runWorkspaceSuite(
				suite,
				suiteDir,
				modelOptions,
				io,
				runDir,
				null,
			);

			const ranCases = caseResults.filter((r) => r.status === 'ran');
			const passCount = ranCases.filter((r) => r.ok).length;
			const totalCount = ranCases.length;
			const score = totalCount > 0 ? passCount / totalCount : 0;
			const editFormat =
				ranCases.length > 0 ? (ranCases[0].editFormat ?? 'patch') : 'patch';

			const entry = {
				score,
				passCount,
				totalCount,
				timestamp: new Date().toISOString(),
				editFormat,
			};
			existingScores.set(modelId, entry);

			if (!options.json) {
				io.stdout.write(
					`  ${modelId}: ${passCount}/${totalCount} (score ${score.toFixed(2)})\n`,
				);
			}
		}

		await saveBenchScores(io.cwd, existingScores);

		const routingTable = computeRoutingTable(existingScores);
		await saveRoutingTable(io.cwd, routingTable);

		const benchResults = {
			suite: suite.name,
			models: Object.fromEntries(existingScores),
			routingTable,
			timestamp: new Date().toISOString(),
		};

		if (options.json) {
			io.stdout.write(`${JSON.stringify(benchResults, null, 2)}\n`);
		} else {
			io.stdout.write(`\n${renderBenchResults(existingScores, routingTable)}`);
			io.stdout.write(`Scores saved to .kodr/bench-scores.json\n`);
			io.stdout.write(`Routing saved to .kodr/routing.json\n`);
		}

		return { ok: true, command: 'bench', benchResults };
	}

	if (options.command === 'why') {
		const runDir = await resolveRunDir(io.cwd, options.whyRunId || '');
		const analysis = await loadRunAnalysis(runDir);
		const story = buildCausalStory(analysis);
		if (options.json) {
			io.stdout.write(
				`${JSON.stringify({ analysis: { ...analysis, contextMd: undefined, promptMd: undefined, responseMd: undefined }, runDir, story }, null, 2)}\n`,
			);
		} else {
			io.stdout.write(renderForensicsCli(analysis, story));
		}
		return { command: 'why', ok: true, runDir, story };
	}

	if (options.command === 'watch') {
		if (!options.testCommand) {
			throw new CliError('kodr watch requires --test <command>');
		}
		const { runWatchLoop } = await import('./watcher.mjs');
		const handle = await runWatchLoop(options, io, handleChannelRequest);
		// Block until the process is interrupted
		await new Promise((resolve) => {
			const onSignal = () => {
				handle.close();
				resolve();
			};
			process.once('SIGINT', onSignal);
			process.once('SIGTERM', onSignal);
		});
		return { ok: true, command: 'watch' };
	}

	throw new CliError(`Command not implemented yet: ${options.command}`);
}

export async function handleChannelRequest(request, io) {
	if (request.kind === 'run-turn') {
		return runPrompt(request.options, io);
	}

	if (request.kind === 'apply-proposal') {
		const treeState = (await gitTreeState(io.cwd)).state;
		const writeResult = await prepareChanges(io.cwd, request.proposal, {
			apply: true,
			protectExisting: request.options?.protectExisting,
			protectedPaths: request.options?.protectedPaths,
		});
		writeResult.treeState = treeState;
		const gitCommitResult =
			request.options?.gitCommit === true
				? await maybeCommitAppliedWrites(io.cwd, request.options, {
						prompt: request.options?.prompt || '',
						runDir: request.runDir || io.cwd,
						runError: null,
						testResult: null,
						writeError: null,
						writeResult,
					})
				: null;
		// Update run artifacts so /undo can find this TUI-accepted apply.
		if (request.runDir && writeResult.applied) {
			await writeJson(join(request.runDir, 'writes.json'), writeResult);
			try {
				const summaryPath = join(request.runDir, 'summary.json');
				const raw = await readFile(summaryPath, 'utf8');
				const summary = JSON.parse(raw);
				summary.applied = true;
				summary.applyDecision = 'late-apply';
				await writeJson(summaryPath, summary);
			} catch {
				// Run dir may predate applyDecision or lack a summary.
			}
		}
		return {
			applied: writeResult.applied,
			gitCommit: gitCommitResult,
			ok: writeResult.applied,
			proposal: request.proposal,
			runDir: request.runDir || '',
			sessionId: request.sessionId || '',
			treeState,
			writeResult,
		};
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

	if (request.kind === 'undo-run') {
		return undoLastApply(io.cwd);
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

export function renderSkillsListing({ skills, shadows, agents, agentShadows }) {
	const lines = [];

	if (skills.length > 0) {
		lines.push('Skills:');
		for (const skill of skills) {
			const desc = skill.description
				? ` — ${skill.description.slice(0, 60)}${skill.description.length > 60 ? '…' : ''}`
				: '';
			const metaOnly = skill.bodyOmitted
				? ' (metadata only — over byte budget)'
				: '';
			lines.push(`  [${skill.tier}] ${skill.name}${desc}${metaOnly}`);
			lines.push(`         ${skill.path}`);
		}
	} else {
		lines.push('Skills: (none)');
	}

	if (shadows.length > 0) {
		lines.push('');
		lines.push('Shadowed skills (lower-tier duplicates):');
		for (const s of shadows) {
			lines.push(`  ${s.name}: ${s.winnerTier} wins over ${s.shadowTier}`);
			lines.push(`    winner:  ${s.winnerPath}`);
			lines.push(`    shadow:  ${s.shadowPath}`);
		}
	}

	if (agents.length > 0) {
		lines.push('');
		lines.push('Agents:');
		for (const agent of agents) {
			const desc = agent.description
				? ` — ${agent.description.slice(0, 60)}${agent.description.length > 60 ? '…' : ''}`
				: '';
			const modelNote = agent.modelSpec
				? ` (model: ${agent.modelSpec})`
				: agent.modelAlias
					? ` (alias: ${agent.modelAlias})`
					: '';
			lines.push(`  [${agent.tier}] ${agent.name}${modelNote}${desc}`);
			lines.push(`         ${agent.sourcePath}`);
		}
	} else {
		lines.push('');
		lines.push('Agents: (none)');
	}

	if (agentShadows?.length > 0) {
		lines.push('');
		lines.push('Shadowed agents (lower-tier duplicates):');
		for (const s of agentShadows) {
			lines.push(`  ${s.name}: ${s.winnerTier} wins over ${s.shadowTier}`);
			lines.push(`    winner:  ${s.winnerPath}`);
			lines.push(`    shadow:  ${s.shadowPath}`);
		}
	}

	return `${lines.join('\n')}\n`;
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
	} else if (flag === '--agent') {
		options.agent = value;
	} else if (flag === '--skill') {
		options.skills.push(value);
	} else if (flag === '--suite') {
		options.suitePath = value;
	} else if (flag === '--test') {
		options.testCommand = value;
		options._testCommandSet = true;
	} else if (flag === '--test-cwd') {
		options.testCwd = value;
		options._testCwdSet = true;
	} else if (flag === '--timeout-ms') {
		options.timeoutMs = Number(value);
		options._timeoutSet = true;
	} else if (flag === '--repair-timeout-ms') {
		options.repairTimeoutMs = Number(value);
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
		options._maxCostUsdSet = true;
	} else if (flag === '--max-retries') {
		options.maxRetries = Number(value);
		options._maxRetriesSet = true;
	} else if (flag === '--max-thinking-tokens') {
		options.maxThinkingTokens = Number(value);
	} else if (flag === '--max-tokens') {
		options.maxTokens = Number(value);
		options._maxTokensSet = true;
	} else if (flag === '--max-turns') {
		options.maxTurns = Number(value);
		options._maxTurnsSet = true;
	} else if (flag === '--host') {
		options.serveHost = value;
	} else if (flag === '--port') {
		options.servePort = Number(value);
	} else if (flag === '--max-active-runs') {
		options.serveMaxActiveRuns = Number(value);
	} else if (flag === '--file') {
		options.inspectFile = value;
	} else if (flag === '--symbol') {
		options.inspectSymbol = value;
	} else if (flag === '--languages') {
		options.inspectLanguages = value
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	} else if (flag === '--patch-retries') {
		options.patchRetries = Number(value);
		options._patchRetriesSet = true;
	} else if (flag === '--prior-scratchpad') {
		options.priorScratchpadPath = value;
	} else if (flag === '--edit-format') {
		options.editFormat = normalizeEditFormat(value);
		options._editFormatSet = true;
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
		structuredOutputMode: options.structuredOutputMode || 'none',
	};

	await writeJson(join(runDir, 'result.json'), result);
	return result;
}

function renderPatchRetryPrompt(failedPatches) {
	const lines = [
		'The following patches did not match the current file content:',
		'',
	];
	for (const fp of failedPatches) {
		const reasonLabel =
			fp.reason === 'no_match'
				? 'no match'
				: fp.reason === 'multiple_matches'
					? `${fp.occurrences} matches`
					: fp.reason;
		lines.push(`## ${fp.path} (${reasonLabel})`, '');
		if (fp.search) {
			lines.push('Your search text:', '```', fp.search, '```', '');
		}
		if (fp.region) {
			lines.push(
				`The closest matching region in the file:`,
				'```',
				fp.region,
				'```',
				'',
			);
		}
	}
	lines.push(
		'Re-emit corrected patches for only these failed paths. Use the same format (JSON with patches array). Do not resend patches that already succeeded.',
	);
	return lines.join('\n');
}

export async function runPrompt(options, io) {
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
			// E4: enable empty-final-turn nudge on the main agent path where the
			// model is expected to return a JSON proposal envelope.
			nudgeEmptyTurn: true,
			...(options.editFormat !== 'blocks'
				? { responseFormat: proposalResponseFormat() }
				: {}),
		};

		// Resolve parent session (if --continue or --session was passed).
		const parent = await resolveParentSession(options, io.cwd);

		// Capture environment facts once per session — byte-stable across all
		// buildWorkspaceContext calls within this run (phase 114).
		const environmentFacts = await captureEnvironmentFacts(io.cwd, {
			model: options.model,
		});

		let skills;
		let memory;
		let context;
		let initialMessages;
		let modelPrompt = prompt;
		let rawInitialMessages;
		let inspectionPlan = null;
		let sessionCompaction = null;
		let contextPackingResult = null;

		// K2: resolve --agent persona before building context.
		let agentPersona = null;
		if (options.agent) {
			const { agents } = await discoverAgents(io.cwd, {
				agentsDirs: resolvedAgentsDirs(options, io.cwd),
			});
			let agentSpec;
			try {
				agentSpec = findAgent(agents, options.agent);
			} catch (err) {
				if (err instanceof AgentError) {
					throw new CliError(err.message);
				}
				throw err;
			}
			agentPersona = agentSpec;
			// If the agent declares a model alias (not a valid kodr spec), warn once.
			if (agentSpec.modelAlias && !agentSpec.modelSpec) {
				io.stderr?.write?.(
					`info: agent "${agentSpec.name}" model "${agentSpec.modelAlias}" is not a kodr model spec; using run default\n`,
				);
			}
			// If the agent has a valid model spec AND --model was not set by the
			// user (flag or env), apply it as the model default for this run.
			if (agentSpec.modelSpec && !options.modelExplicit) {
				options.model = agentSpec.modelSpec;
			}
		}

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
			skills = await loadSkills(io.cwd, options.skills, {
				skillsDirs: resolvedSkillsDirs(options, io.cwd),
			});
			contextPackingResult = await createInspectionContext(
				io.cwd,
				options,
				prompt,
			);
			const inspection = contextPackingResult?.enabled
				? contextPackingResult
				: null;
			if (inspection) {
				const plan = createInspectionTaskPlan(prompt, inspection.index);
				if (hasInspectionTargets(plan)) {
					inspectionPlan = plan;
				}
			}
			context = await buildWorkspaceContext(io.cwd, {
				agentPersona,
				environmentFacts,
				inspection,
				memory,
				skills,
				toolsMode: options.tools,
				...workspaceContextOptions(options),
			});
		} else {
			skills = await loadSkills(io.cwd, options.skills, {
				skillsDirs: resolvedSkillsDirs(options, io.cwd),
			});
			memory = await loadMemory(io.cwd);
			contextPackingResult = await createInspectionContext(
				io.cwd,
				options,
				prompt,
			);
			const inspection = contextPackingResult?.enabled
				? contextPackingResult
				: null;
			if (inspection) {
				const plan = createInspectionTaskPlan(prompt, inspection.index);
				if (hasInspectionTargets(plan)) {
					inspectionPlan = plan;
				}
			}
			modelPrompt = inspectionPlan
				? `${renderInspectionTaskPlan(inspectionPlan)}\n\n${prompt}`
				: prompt;
			context = await buildWorkspaceContext(io.cwd, {
				agentPersona,
				environmentFacts,
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
					skillsDirs: resolvedSkillsDirs(options, io.cwd),
					timeoutMs: options.timeoutMs,
					// W2: pass profile-level tool aliases (overrides built-in defaults).
					toolAliases: options.profileToolAliases || undefined,
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
				// K2: if --agent names an orchestration role, pass it as a role override.
				const agentRoleOverrides =
					agentPersona && isOrchestrationRole(agentPersona.name)
						? { [agentPersona.name]: agentPersona.body }
						: {};
				const orchestrationResult = await runSubagentStages(
					io.cwd,
					runDir,
					prompt,
					{
						...runOptions,
						agentRoleOverrides,
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
				const postWriteDiagnostics = await runPostWriteDiagnostics(
					io.cwd,
					orchestrationResult.writeResult,
					options,
				);
				const healingResult = await runHealingIfNeeded({
					cwd: await verificationCwd(io.cwd, options),
					commandRunner,
					model,
					options,
					postWriteDiagnostics,
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
					workspaceFileCount: contextFileCount(context),
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
				summary.harness = buildHarnessManifest({
					context,
					contextPacking: resolveContextPackingRecord(
						contextPackingResult,
						options,
					),
					inspectionIndex: contextPackingResult?.index ?? null,
					inspectionPlan,
					sessionCompaction,
					proposalFound: orchestrationResult.proposalFound,
					proposalError: null,
					writeResult: orchestrationResult.writeResult,
					writeError: orchestrationResult.writeError ?? null,
					postWriteDiagnostics,
					installResult: orchestrationResult.installResult ?? null,
					testResult,
					healingResult,
				});

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
				await writeJson(join(runDir, 'diagnostics.json'), postWriteDiagnostics);
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
					environmentFacts,
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
				cwd: io.cwd,
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
			configSources: options.configSources || {},
			contextBudget: context.contextBudget || null,
			contextPacking: resolveContextPackingRecord(
				contextPackingResult,
				options,
			),
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
			workspaceFileCount: contextFileCount(context),
		};
		if (completion.transport) {
			summary.transport = completion.transport;
		}
		if (inspectionPlan) {
			summary.inspectionPlan = inspectionPlan.inspection;
		}
		// W3/W4: integrate capture draft from the tool loop.
		// completion.proposalDraft is the ProposalDraft from the registry (may be null
		// if tools were not enabled, or if no write_file/edit_file calls were made).
		const capturedDraft = completion.proposalDraft ?? null;
		const draftNonEmpty = capturedDraft !== null && !capturedDraft.isEmpty;

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

		// W3/W4: merge envelope proposal with captured draft.
		// - draftNonEmpty + no envelope → synthesize from draft (W3)
		// - draftNonEmpty + envelope present → merge, envelope wins per path (W4)
		// - draft empty + envelope → return envelope unchanged (regression guard)
		// - draft empty + no envelope → proposalError path (unchanged)
		if (draftNonEmpty || (capturedDraft !== null && proposal !== null)) {
			// W4 merge (or W3 synthesize when proposal === null).
			// On proposalError + draftNonEmpty: discard the text-parse error and use
			// the draft, since the capture channel is always well-formed.
			if (draftNonEmpty) {
				proposal = mergeProposalWithDraft(capturedDraft, proposal);
				proposalError = null;
			}
		}

		// Alias hits for summary.json
		const aliasHits = capturedDraft?.aliasHits ?? {};

		// proposalChannels for W5 forensics
		const capturedCount =
			(capturedDraft?.files.length ?? 0) + (capturedDraft?.patches.length ?? 0);
		const envelopeCount =
			(proposal?._extractionMeta?.channels?.envelope ?? 0) ||
			(draftNonEmpty
				? 0
				: (proposal?.files?.length ?? 0) + (proposal?.patches?.length ?? 0));

		const proposalChannels = {
			captured: capturedCount,
			envelope:
				proposal?._extractionMeta?.channels?.envelope ??
				(draftNonEmpty ? 0 : envelopeCount),
			aliasHits,
		};

		if (options.editFormat === 'blocks' && proposal) {
			const blocks = extractEditBlocks(completion.text);
			if (blocks.patches.length > 0) {
				proposal = mergeBlockPatches(proposal, blocks);
			}
			if (blocks.errors.length > 0) {
				proposal._blockErrors = blocks.errors;
			}
		}

		if (proposalError) {
			let taskPlan = inspectionPlan || createTaskPlan(prompt);
			summary.applied = false;
			summary.applyDecision = 'none';
			summary.ok = false;
			summary.proposalError = proposalError;
			summary.proposalFound = false;
			summary.proposalChannels = proposalChannels;
			summary.tested = false;
			summary.writeCount = 0;
			taskPlan = updateTasksFromRun(taskPlan, summary);
			summary.taskCounts = taskCounts(taskPlan);
			summary.harness = buildHarnessManifest({
				context,
				contextPacking: resolveContextPackingRecord(
					contextPackingResult,
					options,
				),
				inspectionIndex: contextPackingResult?.index ?? null,
				inspectionPlan,
				sessionCompaction,
				proposalFound: false,
				proposalError,
				writeResult: null,
				writeError: null,
				postWriteDiagnostics: null,
				installResult: null,
				testResult: null,
				healingResult: null,
			});

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
			await writeJson(join(runDir, 'diagnostics.json'), null);
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
		// Resolve how writes will be decided: 'flag' (--yes), 'prompt-accepted',
		// 'prompt-declined', or 'none' (no approver / explicit --dry-run).
		let applyDecision = options.yes ? 'flag' : 'none';
		let shouldApply = options.yes;
		let writeResult = {
			applied: false,
			writes: [],
		};
		let writeError = null;
		let treeState = '';
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
			treeState = (await gitTreeState(io.cwd)).state;
			try {
				const hasApprover =
					typeof options.applyApprover === 'function' && !options._dryRunSet;
				if (!options.yes && hasApprover) {
					// Dry-run first to get the real write list, then ask.
					const dryResult = await prepareChanges(io.cwd, proposal, {
						apply: false,
						protectExisting: options.protectExisting,
						protectedPaths: protectedWritePaths(options),
					});
					if (dryResult.writes.length > 0) {
						const request = createPermissionRequest(
							'apply-writes',
							{ messages: proposalMessages, writes: dryResult.writes },
							'Apply all proposed writes to the workspace?',
						);
						const decision = await options.applyApprover(request);
						if (decision?.decision === 'allow') {
							applyDecision = 'prompt-accepted';
							shouldApply = true;
							writeResult = await prepareChanges(io.cwd, proposal, {
								apply: true,
								protectExisting: options.protectExisting,
								protectedPaths: protectedWritePaths(options),
							});
						} else {
							applyDecision = 'prompt-declined';
							writeResult = dryResult;
						}
					} else {
						writeResult = dryResult;
					}
				} else {
					writeResult = await prepareChanges(io.cwd, proposal, {
						apply: options.yes,
						protectExisting: options.protectExisting,
						protectedPaths: protectedWritePaths(options),
					});
				}
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

			// Patch retry loop: if patches failed to match, send structured
			// feedback to the model and re-apply only the failed patches.
			if (
				!writeError &&
				(writeResult.failedPatches?.length ?? 0) > 0 &&
				options.patchRetries > 0
			) {
				const maxRetryAttempts = options.patchRetries;
				let retryConversation = [...completion.messages];
				let currentFailedPatches = writeResult.failedPatches;
				let retryAttempts = 0;
				const recoveredPaths = [];

				for (
					let attempt = 0;
					attempt < maxRetryAttempts && currentFailedPatches.length > 0;
					attempt += 1
				) {
					retryAttempts += 1;
					const retryPromptText = renderPatchRetryPrompt(currentFailedPatches);
					retryConversation = [
						...retryConversation,
						{ content: retryPromptText, role: 'user' },
					];

					let retryCompletion;
					try {
						retryCompletion = await completeWithContinuations(
							runOptions,
							model,
							'',
							context.systemPrompt,
							{ initialMessages: retryConversation },
						);
					} catch {
						// Model call failed; stop retrying.
						break;
					}

					let retryProposal;
					try {
						retryProposal = extractProposal(retryCompletion.text);
					} catch {
						// Could not parse proposal; stop retrying.
						break;
					}

					if (!retryProposal) {
						break;
					}

					if (options.editFormat === 'blocks' && retryProposal) {
						const retryBlocks = extractEditBlocks(retryCompletion.text);
						if (retryBlocks.patches.length > 0) {
							retryProposal = mergeBlockPatches(retryProposal, retryBlocks);
						}
					}

					// Filter proposal to only the still-failing paths.
					const failingPathSet = new Set(
						currentFailedPatches.map((fp) => fp.path),
					);
					const filteredProposal = {
						...retryProposal,
						patches: (retryProposal.patches ?? []).filter((p) =>
							failingPathSet.has(p.path),
						),
						files: (retryProposal.files ?? []).filter((f) =>
							failingPathSet.has(f.path),
						),
					};

					let retryResult;
					try {
						retryResult = await prepareChanges(io.cwd, filteredProposal, {
							apply: writeResult.applied,
							protectExisting: options.protectExisting,
							protectedPaths: protectedWritePaths(options),
						});
					} catch {
						break;
					}

					// Merge successful writes.
					for (const w of retryResult.writes) {
						recoveredPaths.push(w.path);
						writeResult.writes = writeResult.writes.filter(
							(existing) => existing.path !== w.path,
						);
						writeResult.writes.push(w);
					}

					// Advance conversation for next iteration.
					retryConversation = retryCompletion.messages;

					// Narrow to still-failing patches.
					currentFailedPatches = retryResult.failedPatches ?? [];
				}

				writeResult.failedPatches = currentFailedPatches;
				writeResult.patchRetries = {
					attempts: retryAttempts,
					recoveredPaths,
					unresolved: currentFailedPatches.map((fp) => fp.path),
				};
			}

			writeResult.treeState = treeState;
		}
		const installResult =
			options.installDependencies && shouldApply && !writeError
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
		const postWriteDiagnostics = await runPostWriteDiagnostics(
			io.cwd,
			writeResult,
			options,
		);
		let testResult =
			options.testCommand && shouldApply && !writeError && !runError
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
			options: { ...options, yes: shouldApply },
			postWriteDiagnostics,
			registry,
			runDir,
			systemPrompt: context.systemPrompt,
			testResult,
		});
		if (healingResult?.finalVerification) {
			testResult = healingResult.finalVerification;
		}
		const gitCommitResult = await maybeCommitAppliedWrites(io.cwd, options, {
			prompt,
			runDir,
			runError,
			testResult,
			writeError,
			writeResult,
		});

		summary.applied = writeResult.applied;
		summary.applyDecision = applyDecision;
		summary.dependencyInstallRequired = dependencyInstallRequired;
		summary.gitCommit = gitCommitResult;
		summary.healed = healingResult ? healingResult.healed : false;
		summary.healStopReason = healingResult?.stopReason || '';
		summary.installed = installResult !== null;
		summary.ok =
			writeError || runError ? false : testResult ? testResult.ok : true;
		summary.proposalMessageCount = proposalMessages.length;
		summary.proposalFound = proposal !== null;
		summary.proposalStatus = proposal?.status || '';
		summary.proposalChannels = proposalChannels;
		summary.treeState = treeState;
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
		summary.harness = buildHarnessManifest({
			context,
			contextPacking: summary.contextPacking,
			inspectionIndex: contextPackingResult?.index ?? null,
			inspectionPlan,
			sessionCompaction,
			proposalFound: proposal !== null,
			proposalError: null,
			writeResult,
			writeError,
			postWriteDiagnostics,
			installResult,
			testResult,
			healingResult,
		});

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
		await writeJson(join(runDir, 'git.json'), {
			commit: gitCommitResult,
			treeState,
		});
		await writeJson(join(runDir, 'tests.json'), testResult);
		await writeJson(join(runDir, 'diagnostics.json'), postWriteDiagnostics);
		await writeJson(
			join(runDir, 'patch-retries.json'),
			writeResult.patchRetries ?? null,
		);
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
	environmentFacts,
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
			environmentFacts,
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
	const postWriteDiagnostics = await runPostWriteDiagnostics(
		io.cwd,
		{ applied: options.yes && allWrites.length > 0, writes: allWrites },
		options,
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
		postWriteDiagnostics,
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
		configSources: options.configSources || {},
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
		workspaceFileCount: contextFileCount(context),
		writeCount: writeResult.writes.length,
	};
	if (completion.transport) {
		summary.transport = completion.transport;
	}
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
	summary.harness = buildHarnessManifest({
		context,
		contextPacking: null,
		inspectionIndex: null,
		inspectionPlan: null,
		sessionCompaction: null,
		proposalFound: lastProposal !== null,
		proposalError: null,
		writeResult,
		writeError,
		postWriteDiagnostics,
		installResult,
		testResult,
		healingResult,
	});

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
	await writeJson(join(runDir, 'diagnostics.json'), postWriteDiagnostics);
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
		editFormat: options.editFormat,
		...(options.contextBudgetChars
			? { totalBytes: options.contextBudgetChars }
			: {}),
	};
}

// K3: resolve skills-dir overrides, converting relative paths to absolute.
function resolvedSkillsDirs(options, cwd) {
	return (options.skillsDirs || []).map((dir) =>
		dir.startsWith('/') ? dir : join(cwd, dir),
	);
}

// K3: resolve agents-dir overrides, converting relative paths to absolute.
function resolvedAgentsDirs(options, cwd) {
	return (options.agentsDirs || []).map((dir) =>
		dir.startsWith('/') ? dir : join(cwd, dir),
	);
}

async function runHealingIfNeeded({
	commandRunner,
	cwd,
	model,
	options,
	postWriteDiagnostics,
	registry,
	runDir,
	systemPrompt,
	testResult,
}) {
	if (
		(options.heal !== true && options.heal !== 'auto') ||
		!options.yes ||
		!testResult ||
		testResult.ok
	) {
		return null;
	}

	// S2: repair turns follow the profile's structuredOutput mode like every other
	// turn type. For local profiles the measured default is 'none', which means
	// response_format is never attached — same wire behavior as before (phase 110
	// decision), now enforced by the profile rule rather than a special case.
	const repairOptions = {
		...options,
		maxRetries: Math.min(options.maxRetries, 1),
		maxTurns: Math.min(Math.max(options.maxTurns, 1), 4),
	};

	return runSelfHealingLoop(cwd, testResult, {
		apply: true,
		artifactDir: join(runDir, 'repairs'),
		diagnostics: postWriteDiagnostics,
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
		// D2: explicit --repair-timeout-ms wins; otherwise healing.mjs applies
		// the min(timeoutMs, 240_000) cap automatically.
		...(options.repairTimeoutMs !== ''
			? { turnTimeoutMs: options.repairTimeoutMs }
			: {}),
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
		workspaceFileCount: contextFileCount(details.context),
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
	// F3: write last-run on the failure path so `kodr why` (no arg) works
	// immediately after a failed run — exactly when forensics is most needed.
	if (details.cwd) {
		await writeLastRun(details.cwd, runDir);
	}
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
		conversation: sanitizeSubagentSessionMessages(conversation),
		model: summary.model || '',
		runDir,
		sessionId: summary.sessionId || basename(runDir),
	};
}

// Detect sessions contaminated by a prior --subagent-stages run: those runs
// saved all planner/file-author/reviewer messages verbatim, each with its own
// system message. Multiple system roles confuse subsequent continuation turns.
// Collapse them to a clean user+assistant pair that looks like a normal run.
function sanitizeSubagentSessionMessages(messages) {
	const systemCount = messages.filter((m) => m.role === 'system').length;
	if (systemCount <= 1) {
		return messages;
	}

	const firstUser = messages.find((m) => m.role === 'user');
	if (!firstUser) {
		return messages;
	}

	// Collect file paths from any assistant proposals embedded in the history.
	const written = new Set();
	for (const msg of messages) {
		if (msg.role !== 'assistant' || typeof msg.content !== 'string') {
			continue;
		}
		try {
			const parsed = JSON.parse(msg.content);
			if (Array.isArray(parsed.files)) {
				for (const f of parsed.files) {
					if (typeof f?.path === 'string') {
						written.add(f.path);
					}
				}
			}
		} catch {
			// Not JSON — skip.
		}
	}

	const summary =
		written.size > 0
			? `Implemented: ${[...written].join(', ')}`
			: 'Previous session completed.';

	return [
		firstUser,
		{
			content: JSON.stringify({
				files: [],
				messages: [{ content: summary, level: 'info' }],
				patches: [],
				scratchpad: '',
				status: 'OK',
			}),
			role: 'assistant',
		},
	];
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
	if (options.inspectContext === false) {
		return null;
	}
	const auto = options.inspectContext === 'auto';
	try {
		const index = await inspectWithRegistry(cwd, {
			languages:
				options.inspectLanguages.length > 0
					? options.inspectLanguages
					: undefined,
			lsp: options.lsp || false,
			query: prompt,
		});
		return {
			enabled: true,
			index,
			query: prompt,
			strategy: 'inspection-aware',
		};
	} catch (error) {
		if (auto) {
			return {
				enabled: false,
				fallbackReason: error.message,
				strategy: 'whole-file',
			};
		}
		throw error;
	}
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
			: result.applyDecision === 'prompt-declined'
				? 'dry-run (declined)'
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
		if (result.treeState && result.treeState !== 'not-a-repo') {
			lines.push(`Tree before apply: ${result.treeState}`);
		}
		if (result.gitCommit?.committed) {
			lines.push(
				`Committed: ${result.gitCommit.sha.slice(0, 10)} (${result.gitCommit.files.length} file(s))`,
			);
		} else if (result.gitCommit?.error) {
			lines.push(`Commit: ${result.gitCommit.error}`);
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
	} else if (
		!result.proposalError &&
		!result.proposal &&
		result.responseChars !== undefined &&
		result.responseChars <= 2
	) {
		// E4: near-empty response (whitespace only) with no proposal — surface
		// this clearly so the user and forensics know what happened.
		// responseChars <= 2 covers "\n\n" (2 chars) and "" (0 chars).
		lines.push('');
		lines.push(
			`Proposal: MISSING — response was empty (${result.responseChars} chars)`,
		);
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
		const hr = result.healingResult;
		if (hr.stopReason === 'timeout') {
			// D2: surface elapsed and limit so the user knows what happened and
			// how to raise the budget.
			const timedOut = hr.repairs?.find((r) => r.stopReason === 'timeout');
			const elapsed = timedOut?.elapsedMs ?? timedOut?.durationMs;
			const limit = timedOut?.timeoutMs;
			const elapsedSec =
				elapsed != null ? `${Math.round(elapsed / 1000)}s` : '?';
			const limitSec = limit != null ? `${Math.round(limit / 1000)}s` : '?';
			lines.push(
				`Repairs: not healed (timeout) — repair turn timed out after ${elapsedSec} (limit ${limitSec}). Raise with --repair-timeout-ms.`,
			);
		} else {
			lines.push(
				`Repairs: ${hr.healed ? 'healed' : 'not healed'} (${hr.stopReason})`,
			);
		}
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
		if (result.applyDecision === 'prompt-declined') {
			lines.push(
				'Apply declined. Re-run with --yes to apply, or omit --dry-run to be prompted again.',
			);
		} else {
			lines.push('Re-run with --yes to apply these changes.');
		}
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

// Write the path of the most recent run dir to .kodr/last-run so that
// --continue and `kodr why` can find it without the user naming the session.
// Called on both success and failure (writeRunFailure also calls it when cwd
// is available) so forensics work immediately after a failed run.
async function writeLastRun(cwd, runDir) {
	const kodrDir = join(cwd, '.kodr');
	await mkdir(kodrDir, { recursive: true });
	await writeFile(join(kodrDir, 'last-run'), `${runDir}\n`, 'utf8');
}

// F7: in tools mode the packed files array is empty and the listing lives in
// context.fileMap. Fall back to fileMap.total so the count is never 0.
function contextFileCount(context) {
	if (context.files.length > 0) return context.files.length;
	return context.fileMap?.total ?? 0;
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

function hasInspectionTargets(plan) {
	return (
		(plan?.inspection?.targetFiles?.length ?? 0) > 0 ||
		(plan?.inspection?.targetSymbols?.length ?? 0) > 0
	);
}

function resolveContextPackingRecord(inspectionResult, options) {
	if (options.tools) {
		return { fallbackReason: null, lspInspectors: [], strategy: 'file-map' };
	}
	if (inspectionResult?.enabled) {
		return {
			fallbackReason: null,
			lspInspectors: inspectionResult.index?.lspInspectors ?? [],
			strategy: 'inspection-aware',
		};
	}
	return {
		fallbackReason: inspectionResult?.fallbackReason || null,
		lspInspectors: [],
		strategy: 'whole-file',
	};
}
