import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createRunArtifacts, writeJson, writeText } from './artifacts.mjs';
import {
	buildWorkspaceContext,
	listContextFiles,
	renderContextMarkdown,
} from './context-packer.mjs';
import { extractJson, JsonExtractionError } from './json-extractor.mjs';
import {
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
	createTaskPlan,
	taskCounts,
	updateTasksFromRun,
} from './task-plan.mjs';
import { runVerification } from './verification-runner.mjs';
import { replayRun } from './replay.mjs';
import { completeWithToolCalls, createBuiltinRegistry } from './tool-calls.mjs';
import { runComparison } from './compare.mjs';
import { loadEvalSuite, scoreCase } from './eval.mjs';
import { startKodrServer } from './server.mjs';
import { inspectWorkspace } from './code-inspector.mjs';
import { checkAvailability, REGISTRY } from './external-inspector-registry.mjs';
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
import { runTui } from './tui.mjs';
import { VERSION } from './version.mjs';

export { VERSION };

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL_ID = 'qwen/qwen3.6-35b-a3b';
const DEFAULT_TIMEOUT_MS = 600000;
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
		dryRun: true,
		extraHeaders: {},
		help: false,
		inspectSymbol: '',
		inspectContext: false,
		json: false,
		model: env.MODEL_ID || DEFAULT_MODEL_ID,
		out: '',
		apiKey: env.OPENAI_API_KEY || '',
		prompt: '',
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
		promptId: '',
		promptHistoryId: '',
		sessionId: '',
		sessionFormat: 'markdown',
		sessionSubcommand: '',
		serveHost: DEFAULT_SERVE_HOST,
		servePort: DEFAULT_SERVE_PORT,
		tools: false,
		testCwd: '',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		transcriptFile: '',
		maxCostUsd: '',
		maxRetries: 7,
		maxTokens: '',
		maxTurns: 8,
		version: false,
		yes: false,
		_apiKeySet: false,
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
			arg === '--model' ||
			arg === '--api-key' ||
			arg === '--out' ||
			arg === '-p' ||
			arg === '--prompt' ||
			arg === '--prompt-file' ||
			arg === '--prompt-id' ||
			arg === '--skill' ||
			arg === '--suite' ||
			arg === '--test' ||
			arg === '--test-cwd' ||
			arg === '--timeout-ms' ||
			arg === '--transcript-file' ||
			arg === '--format' ||
			arg === '--max-cost-usd' ||
			arg === '--max-retries' ||
			arg === '--max-tokens' ||
			arg === '--max-turns' ||
			arg === '--session' ||
			arg === '--host' ||
			arg === '--port' ||
			arg === '--symbol'
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
	delete options._apiKeySet;

	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
		throw new CliError(
			'--timeout-ms must be an integer greater than or equal to 100',
		);
	}
	validateLoopBudgetOptions(options);
	validateServeOptions(options);

	return options;
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
		options.maxCostUsd !== '' &&
		(!Number.isFinite(Number(options.maxCostUsd)) ||
			Number(options.maxCostUsd) < 0)
	) {
		throw new CliError('--max-cost-usd must be a non-negative number');
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
  kodr run -p "task" --yes [--test "npm test"] [--test-cwd path]
  kodr run -p "task" --yes --protect-existing
  kodr run -p "task" --stream
  kodr run -p "task" --tools
  kodr run -p "task" --inspect-context
  kodr run -p "follow up" --continue
  kodr run -p "follow up" --session <run-id>
  kodr tui [--session <run-id>]
  kodr tui --continue
  kodr serve [--host 127.0.0.1] [--port 8787]
  kodr inspect [--symbol name] [--json]
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
  --api-key KEY        Default: OPENAI_API_KEY
  --timeout-ms N       Default: ${DEFAULT_TIMEOUT_MS}
  --max-turns N        Max model turns in a run. Default: 8
  --max-retries N      Max continuation retries after length stops. Default: 7
  --max-tokens N       Optional total token budget from model usage
  --max-cost-usd N     Optional cost budget when usage includes costUsd

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

Web channel:
  kodr serve           Start a local-only JSON HTTP channel.
                       Routes: GET /sessions, GET /sessions/:id, POST /turn

Implemented library primitives:
  workflow planning, bounded cycles, one-shot healing, ReAct tools, model comparison
`;
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
			});
			io.stdout.write(renderContextMarkdown(context));
			return { ok: true, command: 'run', context };
		}

		const result = await handleChannelRequest(
			{ kind: 'run-turn', options },
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
		const index = await inspectWorkspace(io.cwd, {
			symbol: options.inspectSymbol,
		});
		if (options.json) {
			io.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
		} else {
			io.stdout.write(renderInspection(index, options.inspectSymbol));
		}
		return { ok: true, command: 'inspect', index };
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
		const context = await buildWorkspaceContext(io.cwd, { memory });

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
		const context = await buildWorkspaceContext(io.cwd, { memory, skills });
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

	if (request.kind === 'verify-command') {
		if (!request.options.testCommand) {
			throw new CliError('No test command configured');
		}
		return runVerification(
			await verificationCwd(io.cwd, request.options),
			request.options.testCommand,
			{ timeoutMs: request.options.timeoutMs },
		);
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

export function renderInspection(index, symbolName = '') {
	const lines = [
		`Code inspection: ${index.files.length} files, ${index.symbols.length} symbols`,
	];
	const languages = Object.entries(index.languages)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([language, count]) => `${language}=${count}`)
		.join(', ');
	if (languages) {
		lines.push(`Languages: ${languages}`);
	}

	for (const file of index.files) {
		lines.push('');
		lines.push(`${file.path} (${file.language})`);
		for (const symbol of file.symbols) {
			lines.push(
				`  ${symbol.kind} ${symbol.name} lines ${symbol.lineStart}-${symbol.lineEnd}`,
			);
		}
	}

	if (symbolName) {
		lines.push('');
		lines.push(`References for ${symbolName}: ${index.references.length}`);
		for (const reference of index.references) {
			lines.push(`  ${reference.path}:${reference.line} ${reference.text}`);
		}
	}

	return `${lines.join('\n')}\n`;
}

function fencedMarkdown(text) {
	const fence = text.includes('```') ? '````' : '```';
	return `${fence}\n${text}\n${fence}`;
}

function assignValue(options, flag, value) {
	if (flag === '--base-url') {
		options.baseUrl = value.replace(/\/+$/u, '');
	} else if (flag === '--model') {
		options.model = value;
	} else if (flag === '--api-key') {
		options.apiKey = value;
		options._apiKeySet = true;
	} else if (flag === '--out') {
		options.out = value;
	} else if (flag === '-p' || flag === '--prompt') {
		options.prompt = value;
	} else if (flag === '--prompt-file') {
		options.promptFile = value;
	} else if (flag === '--prompt-id') {
		options.promptId = value;
	} else if (flag === '--session') {
		options.sessionId = value;
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
	} else if (flag === '--transcript-file') {
		options.transcriptFile = value;
	} else if (flag === '--format') {
		options.sessionFormat = value;
	} else if (flag === '--max-cost-usd') {
		options.maxCostUsd = value;
	} else if (flag === '--max-retries') {
		options.maxRetries = Number(value);
	} else if (flag === '--max-tokens') {
		options.maxTokens = Number(value);
	} else if (flag === '--max-turns') {
		options.maxTurns = Number(value);
	} else if (flag === '--host') {
		options.serveHost = value;
	} else if (flag === '--port') {
		options.servePort = Number(value);
	} else if (flag === '--symbol') {
		options.inspectSymbol = value;
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
		ok: true,
		reply,
		runDir,
	};

	await writeJson(join(runDir, 'result.json'), result);
	return result;
}

async function runPrompt(options, io) {
	const prompt = await loadPrompt(options, io.cwd);
	const promptId = resolvePromptId(options, prompt);
	const runDir = await createRunArtifacts(io.cwd, options.out);

	// Resolve parent session (if --continue or --session was passed).
	const parent = await resolveParentSession(options, io.cwd);

	let skills;
	let memory;
	let context;
	let initialMessages;

	if (parent) {
		// Continuation: freeze the system prompt from the parent transcript.
		// The parent conversation ends with the model's last reply; append the new
		// user turn and hand the whole history to the completion function.
		const parentMessages = parent.conversation;
		initialMessages = [...parentMessages, { role: 'user', content: prompt }];
		// Build a minimal context for artifacts (context.md, workspaceFileCount).
		memory = await loadMemory(io.cwd);
		skills = await loadSkills(io.cwd, options.skills);
		context = await buildWorkspaceContext(io.cwd, {
			inspection: await createInspectionContext(io.cwd, options, prompt),
			memory,
			skills,
			toolsMode: options.tools,
		});
	} else {
		skills = await loadSkills(io.cwd, options.skills);
		memory = await loadMemory(io.cwd);
		context = await buildWorkspaceContext(io.cwd, {
			memory,
			skills,
			toolsMode: options.tools,
		});
		initialMessages = [
			{ role: 'system', content: context.systemPrompt },
			{ role: 'user', content: prompt },
		];
	}

	const registry = options.tools ? createBuiltinRegistry(io.cwd) : null;
	const responsePath = join(runDir, 'response.md');
	await writeText(join(runDir, 'context.md'), renderContextMarkdown(context));
	await writeText(join(runDir, 'prompt.md'), prompt);

	let model;
	let completion;

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

		const rawRequest = {
			messages: initialMessages,
			model,
			url: `${options.baseUrl}/chat/completions`,
		};
		if (registry) {
			rawRequest.tools = registry.toApiTools();
		}
		await writeJson(join(runDir, 'raw-request.json'), rawRequest);

		const contOpts = parent ? { initialMessages } : {};
		completion = options.tools
			? await completeWithToolCalls(
					options,
					model,
					prompt,
					context.systemPrompt,
					registry,
					contOpts,
				)
			: await completeWithContinuations(
					options,
					model,
					prompt,
					context.systemPrompt,
					contOpts,
				);

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
			prompt,
			promptId,
			rawRequestTools: registry ? registry.toApiTools() : null,
			responsePath,
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
			messages: 'messages.json',
			prompt: 'prompt.md',
			rawRequest: 'raw-request.json',
			rawResponse: 'raw-response.json',
			response: 'response.md',
			scratchpad: 'scratchpad.md',
			summary: 'summary.json',
			tasks: 'tasks.json',
			tests: 'tests.json',
			writes: 'writes.json',
		},
		baseUrl: options.baseUrl,
		finishReasons: completion.finishReasons,
		loopBudget: completion.loopBudget,
		model,
		ok: true,
		parentRunDir: parent ? parent.runDir : null,
		promptChars: prompt.length,
		promptId,
		responseChars: completion.text.length,
		responseCount: completion.responses.length,
		sessionId,
		timestamp: new Date().toISOString(),
		usage: usageFromBudget(completion.loopBudget),
		workspaceFileCount: context.files.length,
	};
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
		let taskPlan = createTaskPlan(prompt);
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
		await writeJson(join(runDir, 'conversation.json'), completion.messages);
		await writeJson(join(runDir, 'messages.json'), []);
		await writeText(join(runDir, 'scratchpad.md'), '');
		await writeJson(join(runDir, 'raw-response.json'), {
			loopBudget: completion.loopBudget,
			responses: completion.responses,
		});
		await writeJson(join(runDir, 'summary.json'), summary);
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
	let taskPlan = createTaskPlan(
		prompt,
		proposal ? proposalPaths(proposal) : [],
	);
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
	const testResult =
		options.testCommand && options.yes && !writeError
			? await runVerification(
					await verificationCwd(io.cwd, options),
					options.testCommand,
					{
						timeoutMs: options.timeoutMs,
					},
				)
			: null;

	summary.applied = writeResult.applied;
	summary.ok = writeError ? false : testResult ? testResult.ok : true;
	summary.proposalMessageCount = proposalMessages.length;
	summary.proposalFound = proposal !== null;
	summary.proposalStatus = proposal?.status || '';
	summary.tested = testResult !== null;
	if (writeError) {
		summary.writeError = writeError;
	}
	summary.writeCount = writeResult.writes.length;
	taskPlan = updateTasksFromRun(taskPlan, summary);
	summary.taskCounts = taskCounts(taskPlan);

	await writeText(responsePath, completion.text);
	await writeJson(join(runDir, 'conversation.json'), completion.messages);
	await writeJson(join(runDir, 'messages.json'), proposalMessages);
	await writeText(join(runDir, 'scratchpad.md'), scratchpad);
	await writeJson(join(runDir, 'raw-response.json'), {
		loopBudget: completion.loopBudget,
		responses: completion.responses,
	});
	await writeJson(join(runDir, 'summary.json'), summary);
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
		scratchpad,
		testResult,
		taskPlan,
		writeResult,
	};
}

async function writeRunFailure(runDir, details) {
	const taskPlan = createTaskPlan(details.prompt);
	const error = {
		message: details.error.message,
		name: details.error.name,
	};
	const rawRequest = {
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
			rawRequest: 'raw-request.json',
			rawResponse: 'raw-response.json',
			response: 'response.md',
			scratchpad: 'scratchpad.md',
			summary: 'summary.json',
			tasks: 'tasks.json',
			tests: 'tests.json',
			writes: 'writes.json',
		},
		baseUrl: details.baseUrl,
		error,
		model: details.model,
		ok: false,
		parentRunDir: null,
		promptChars: details.prompt.length,
		promptId: details.promptId || '',
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
	await writeJson(join(runDir, 'summary.json'), summary);
	await writeJson(join(runDir, 'tasks.json'), taskPlan);
	await writeJson(join(runDir, 'tests.json'), null);
	await writeJson(join(runDir, 'writes.json'), {
		applied: false,
		writes: [],
	});
}

async function verificationCwd(cwd, options) {
	if (!options.testCwd) {
		return cwd;
	}

	const testCwd = await jailedPath(cwd, options.testCwd);
	return testCwd.absolute;
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
		conversation = JSON.parse(
			await readFile(join(runDir, 'conversation.json'), 'utf8'),
		);
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

function extractProposal(text) {
	try {
		const value = extractJson(text);
		if (
			!value ||
			(!Array.isArray(value.files) &&
				!Array.isArray(value.patches) &&
				!Array.isArray(value.messages) &&
				typeof value.status !== 'string' &&
				typeof value.scratchpad !== 'string')
		) {
			return null;
		}

		const files = Array.isArray(value.files) ? value.files : [];
		const patches = Array.isArray(value.patches) ? value.patches : [];
		const messages = Array.isArray(value.messages) ? value.messages : [];
		const status = parseProposalStatus(value.status);

		return {
			files: files.map((file) => {
				if (
					!file ||
					typeof file.path !== 'string' ||
					typeof file.content !== 'string'
				) {
					throw new CliError(
						'Proposal files must have string path and content',
					);
				}

				return {
					content: file.content,
					path: file.path,
				};
			}),
			// Messages are informational only — filter out malformed entries
			// rather than rejecting the whole proposal over a bad annotation.
			messages: messages
				.filter(
					(message) =>
						message &&
						typeof message.level === 'string' &&
						typeof message.content === 'string',
				)
				.map((message) => ({
					content: message.content,
					level: message.level,
				})),
			scratchpad: typeof value.scratchpad === 'string' ? value.scratchpad : '',
			status,
			patches: patches.map((patch) => {
				if (
					!patch ||
					typeof patch.path !== 'string' ||
					typeof patch.search !== 'string' ||
					typeof patch.replace !== 'string'
				) {
					throw new CliError(
						'Proposal patches must have string path, search, and replace',
					);
				}

				return {
					path: patch.path,
					replace: patch.replace,
					search: patch.search,
				};
			}),
		};
	} catch (error) {
		if (error instanceof JsonExtractionError) {
			return null;
		}
		throw error;
	}
}

async function createInspectionContext(cwd, options, prompt) {
	if (!options.inspectContext) {
		return null;
	}
	return {
		enabled: true,
		index: await inspectWorkspace(cwd),
		query: prompt,
	};
}

async function loadOptionalPrompt(options, cwd) {
	if (!options.prompt && !options.promptFile) {
		return '';
	}
	return loadPrompt(options, cwd);
}

function parseProposalStatus(value) {
	if (value === undefined) {
		return 'OK';
	}

	if (typeof value !== 'string') {
		throw new CliError('Proposal status must be "OK" or "ERROR"');
	}

	const status = value.toUpperCase();
	if (status !== 'OK' && status !== 'ERROR') {
		throw new CliError('Proposal status must be "OK" or "ERROR"');
	}

	return status;
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
		const mode = result.applied ? 'applied' : 'dry-run (no changes written)';
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
// when the server sent no usage data (tokens === 0 and costUsd === 0).
function usageFromBudget(budget) {
	if (!budget) {
		return null;
	}
	const { tokens, promptTokens, completionTokens, costUsd } = budget;
	if (tokens === 0 && costUsd === 0) {
		return null;
	}
	return {
		completionTokens: completionTokens ?? 0,
		costUsd: costUsd ?? 0,
		promptTokens: promptTokens ?? 0,
		tokens: tokens ?? 0,
	};
}

// Format a usage object as a single human-readable line.
// e.g. "Tokens: 1,234 (prompt 900 / completion 334)  Cost: $0.0021"
function renderUsageLine(usage) {
	if (!usage) {
		return '';
	}
	const total = usage.tokens.toLocaleString();
	let line = `Tokens: ${total}`;
	if (usage.promptTokens > 0 || usage.completionTokens > 0) {
		line += ` (prompt ${usage.promptTokens.toLocaleString()} / completion ${usage.completionTokens.toLocaleString()})`;
	}
	if (usage.costUsd > 0) {
		line += `  Cost: $${usage.costUsd.toFixed(4)}`;
	}
	return line;
}

function proposalPaths(proposal) {
	return [
		...proposal.files.map((file) => file.path),
		...proposal.patches.map((patch) => patch.path),
	];
}
