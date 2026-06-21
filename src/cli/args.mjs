// cli/args.mjs — CLI argument parsing (parseArgs), flag assignment
// (assignValue), and option validators. Extracted from
// app.mjs in phase 148 (app split). app.mjs imports + re-exports parseArgs and
// usage to keep the public surface stable; usage now lives in usage.mjs.

import { join } from 'node:path';
import { CliError } from '../cli-errors.mjs';
import {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL_ID,
	DEFAULT_SERVE_HOST,
	DEFAULT_SERVE_PORT,
	DEFAULT_TIMEOUT_MS,
	OPENROUTER_DEFAULT_MODEL,
} from './defaults.mjs';
import {
	OPENROUTER_BASE_URL,
	OPENROUTER_EXTRA_HEADERS,
} from '../completion.mjs';
import { normalizeEditFormat } from '../edit-formats.mjs';
import { applyModelProfileDefaults } from '../model-profiles.mjs';
import {
	ModelSpecError,
	parseAgentModelOverride,
	resolveAgentModels,
	resolveModelOptions,
} from '../model-specs.mjs';
// Sandbox option validators/defaults come from the light sandbox-options.mjs
// (phase 149) so parseArgs does not statically load docker-executor /
// openshell-executor (node:child_process + the full sandbox machinery).
import {
	dockerDefaults,
	openshellDefaults,
	validateDockerOptions,
	validateOpenShellOptions,
} from '../sandbox-options.mjs';
import {
	APPLY_MODES,
	applyProjectConfig,
	loadProjectConfig,
	ProjectConfigError,
} from '../project-config.mjs';
import { DEFAULT_SESSION_CONTEXT_CHARS } from '../session-compaction.mjs';
export { usage } from './usage.mjs';

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
		protectExisting: true,
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
		// Phase 126: inter-chunk idle deadline. '' → model-client default.
		idleTimeoutMs: '',
		// Phase 127: kodr trends run archive dir. '' → <cwd>/.kodr/runs.
		runsDir: '',
		// Phase 129: kodr trends windowing.
		trendsSince: '',
		trendsLast: 0,
		// Phase 132: kodr trends --html dashboard.
		trendsHtml: false,
		// Phase 131: kodr route.
		routeApply: false,
		routeMinRuns: 0,
		// Phase 141: --route-auto selects model from run-history at run start.
		routeAuto: false,
		routeAutoModel: '',
		suitePath: '',
		// Phase 150: auto-detect a test command for run/tui when none is set.
		// --no-test sets this false.
		autoTest: true,
		// Phase 156: executable smoke-check — load-probe the project entry point
		// after applying writes. --no-smoke sets this false.
		smoke: true,
		// Phase 160: cross-reference sensors — compose/Dockerfile and CSS/HTML
		// structural consistency checks. --no-sensors sets this false.
		sensors: true,
		// Phase 166: kodr check --strict makes advisory warnings (smoke-check
		// failures, sensor warns) exit non-zero. Off by default.
		strict: false,
		// Phase 171: kodr check --changed scans only git-modified files.
		changed: false,
		// Phase 175: kodr check --watch re-runs on file changes.
		watch: false,
		// Phase 183: kodr check --deep follows imports transitively for cycle detection.
		deep: false,
		// Phase 174: kodr hook <sub-command>
		hookSubcommand: '',
		// Phase 191: kodr hook install/uninstall --pre-push targets the pre-push hook.
		prePush: false,
		// Phase 193: per-sensor toggles from .kodr/config.json sensors block.
		// Maps sensor names (from SENSOR_NAMES values) to boolean enabled/disabled.
		sensorToggles: {},
		// Phase 194: kodr check --fix — when issues are found, synthesize a repair
		// prompt and pass it to the model for a targeted fix run.
		fix: false,
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
		webDir: '',
		staged: 'auto',
		subagentStages: false,
		skipReview: false,
		repairTimeoutMs: '',
		reviewTimeoutMs: '',
		tools: 'auto',
		testCwd: '',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		transcriptFile: '',
		applyMode: 'proposal',
		// Phase 124: force the Node/ESM language-guidance block off even when the
		// workspace signals Node/ESM. The A-arm of the guidance A/B measurement.
		suppressLanguageGuidance: false,
		// Phase 145: force the model-family guidance block off even when the model
		// matches a known family. The A-arm of the model-guidance A/B measurement.
		suppressModelGuidance: false,
		maxCostUsd: '',
		maxRetries: 7,
		maxThinkingTokens: '',
		maxTokens: '',
		maxTurns: 8,
		patchRetries: 2,
		version: false,
		yes: false,
		// Phase 151: run applies + verifies by default; --confirm re-enables the
		// interactive apply prompt for a TTY run.
		confirm: false,
		_apiKeySet: false,
		_applyModeSet: false,
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
		_maxThinkingTokensSet: false,
		_maxTokensSet: false,
		_maxTurnsSet: false,
		_modelSet: false,
		_patchRetriesSet: false,
		_modelEnvSet: Boolean(env.MODEL_ID),
		_protectExistingSet: false,
		_sessionContextSet: false,
		_firstTokenTimeoutSet: false,
		_idleTimeoutSet: false,
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

		// Phase 151: restore the interactive y/N apply prompt for a TTY `run`.
		// `run` applies by default now; --confirm opts back into confirming first.
		if (arg === '--confirm') {
			options.confirm = true;
			continue;
		}

		if (arg === '--protect-existing') {
			options.protectExisting = true;
			options._protectExistingSet = true;
			continue;
		}

		if (arg === '--no-protect-existing') {
			options.protectExisting = false;
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

		if (arg === '--pre-push') {
			options.prePush = true;
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

		if (arg === '--idle-timeout-ms') {
			options.idleTimeoutMs = Number(argv[++index]);
			options._idleTimeoutSet = true;
			continue;
		}

		if (arg === '--runs-dir') {
			options.runsDir = argv[++index];
			continue;
		}

		if (arg === '--since') {
			options.trendsSince = argv[++index];
			continue;
		}

		if (arg === '--last') {
			options.trendsLast = Number(argv[++index]);
			continue;
		}

		if (arg === '--apply') {
			options.routeApply = true;
			continue;
		}

		if (arg === '--route-auto') {
			options.routeAuto = true;
			continue;
		}

		if (arg === '--min-runs') {
			options.routeMinRuns = Number(argv[++index]);
			continue;
		}

		if (arg === '--html') {
			options.trendsHtml = true;
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

		// Phase 150: opt out of test auto-detection (and any inherited test
		// command). An explicit --test still wins if given.
		if (arg === '--no-test') {
			options.testCommand = '';
			options._testCommandSet = true;
			options.autoTest = false;
			continue;
		}

		// Phase 156: opt out of the executable smoke-check (entry-point load probe).
		if (arg === '--no-smoke') {
			options.smoke = false;
			continue;
		}

		// Phase 160: opt out of deterministic cross-reference sensors.
		if (arg === '--no-sensors') {
			options.sensors = false;
			continue;
		}

		// Phase 166: strict mode — advisory warnings become check failures.
		if (arg === '--strict') {
			options.strict = true;
			continue;
		}

		// Phase 171: only scan git-modified files.
		if (arg === '--changed') {
			options.changed = true;
			continue;
		}

		// Phase 175: re-run on file changes.
		if (arg === '--watch') {
			options.watch = true;
			continue;
		}

		// Phase 183: follow imports transitively for cycle detection.
		if (arg === '--deep') {
			options.deep = true;
			continue;
		}

		// Phase 185: --ci is a shorthand for --changed --strict.
		if (arg === '--ci') {
			options.changed = true;
			options.strict = true;
			continue;
		}

		if (arg === '--fix') {
			options.fix = true;
			continue;
		}

		if (arg === '--no-language-guidance') {
			options.suppressLanguageGuidance = true;
			continue;
		}
		if (arg === '--no-model-guidance') {
			options.suppressModelGuidance = true;
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
			arg === '--web-dir' ||
			arg === '--file' ||
			arg === '--symbol' ||
			arg === '--languages' ||
			arg === '--patch-retries' ||
			arg === '--prior-scratchpad' ||
			arg === '--edit-format' ||
			arg === '--apply-mode'
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
		} else if (options.command === 'check' && positionals.length === 2) {
			// Phase 170: kodr check [dir] — run against a specific directory.
			options.checkDir = positionals[1];
		} else if (options.command === 'hook' && positionals.length === 2) {
			// Phase 174: kodr hook <sub-command> (e.g. install)
			options.hookSubcommand = positionals[1];
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
		applyMode: options._applyModeSet ? 'flag' : 'builtin',
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
		Object.assign(options, applyModelProfileDefaults(options, env, cwd));
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
				cwd,
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
	delete options._applyModeSet;
	delete options._baseUrlEnvSet;
	delete options._baseUrlSet;
	delete options._completionReserveSet;
	delete options._contextWindowSet;
	delete options._editFormatSet;
	delete options._firstTokenTimeoutSet;
	delete options._healSet;
	delete options._idleTimeoutSet;
	delete options._inspectContextSet;
	delete options._lspSet;
	delete options._maxCostUsdSet;
	delete options._maxRetriesSet;
	delete options._maxThinkingTokensSet;
	delete options._maxTokensSet;
	delete options._maxTurnsSet;
	delete options._modelEnvSet;
	delete options._modelSet;
	delete options._patchRetriesSet;
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

// assignValue maps a "--flag value" pair onto the options object. Flags that
// take a value are gathered into the single OR block in parseArgs above; this
// function does the per-flag assignment (and any per-flag sentinel bookkeeping).
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
		options._maxThinkingTokensSet = true;
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
	} else if (flag === '--web-dir') {
		options.webDir = value;
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
	} else if (flag === '--apply-mode') {
		if (!APPLY_MODES.includes(value)) {
			throw new CliError(
				`--apply-mode must be one of: ${APPLY_MODES.join(', ')} (got: ${value})`,
			);
		}
		options.applyMode = value;
		options._applyModeSet = true;
	}
}
