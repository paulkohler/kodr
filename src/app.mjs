import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
	firstFinishReason,
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
import { createLoopBudget } from './loop-budgets.mjs';
import { VERSION } from './version.mjs';

export { VERSION };

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL_ID = 'qwen/qwen3.6-35b-a3b';
const DEFAULT_TIMEOUT_MS = 600000;
const PROBE_PROMPT = 'Reply with exactly: kodr-probe-ok';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-4o-mini';
const OPENROUTER_EXTRA_HEADERS = {
	'HTTP-Referer': 'https://github.com/pkohler/koder-by-codex',
	'X-Title': 'kodr',
};

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
		testCommand: '',
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

		if (arg === '--show-context') {
			options.showContext = true;
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

		if (
			arg === '--base-url' ||
			arg === '--model' ||
			arg === '--api-key' ||
			arg === '--out' ||
			arg === '-p' ||
			arg === '--prompt' ||
			arg === '--prompt-file' ||
			arg === '--skill' ||
			arg === '--test' ||
			arg === '--test-cwd' ||
			arg === '--timeout-ms' ||
			arg === '--transcript-file' ||
			arg === '--max-cost-usd' ||
			arg === '--max-retries' ||
			arg === '--max-tokens' ||
			arg === '--max-turns'
		) {
			const value = argv[index + 1];
			if (!value || value.startsWith('--')) {
				throw new CliError(`${arg} requires a value`);
			}
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

export function usage() {
	return `kodr ${VERSION}

Usage:
  kodr --help
  kodr --version
  kodr probe [--json]
  kodr run -p "task" [--json]
  kodr run --prompt-file prompt.md [--out .kodr/runs/name]
  kodr run -p "task" --dry-run
  kodr run -p "task" --yes [--test "npm test"] [--test-cwd path]
  kodr run -p "task" --stream
  kodr run --show-files
  kodr run --show-context
  kodr run --show-skills
  kodr cycle-review --transcript-file chat.md [--json]
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
			const context = await buildWorkspaceContext(io.cwd, { memory });
			io.stdout.write(renderContextMarkdown(context));
			return { ok: true, command: 'run', context };
		}

		const result = await runPrompt(options, io);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`${result.ok ? 'Run ok' : 'Run failed'}\n`);
			io.stdout.write(`Run: ${result.runDir}\n`);
			io.stdout.write(`Model: ${result.model}\n`);
			io.stdout.write(`Response: ${result.responsePath}\n`);
		}
		return { ok: result.ok, command: 'run', result };
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

	throw new CliError(`Command not implemented yet: ${options.command}`);
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
	} else if (flag === '--skill') {
		options.skills.push(value);
	} else if (flag === '--test') {
		options.testCommand = value;
	} else if (flag === '--test-cwd') {
		options.testCwd = value;
	} else if (flag === '--timeout-ms') {
		options.timeoutMs = Number(value);
	} else if (flag === '--transcript-file') {
		options.transcriptFile = value;
	} else if (flag === '--max-cost-usd') {
		options.maxCostUsd = value;
	} else if (flag === '--max-retries') {
		options.maxRetries = Number(value);
	} else if (flag === '--max-tokens') {
		options.maxTokens = Number(value);
	} else if (flag === '--max-turns') {
		options.maxTurns = Number(value);
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
	const runDir = await createRunArtifacts(io.cwd, options.out);
	const skills = await loadSkills(io.cwd, options.skills);
	const memory = await loadMemory(io.cwd);
	const context = await buildWorkspaceContext(io.cwd, { memory, skills });
	const responsePath = join(runDir, 'response.md');
	await writeText(join(runDir, 'context.md'), renderContextMarkdown(context));
	await writeText(join(runDir, 'prompt.md'), prompt);

	let modelsResponse;
	let model;
	let completion;

	try {
		modelsResponse = await listModels(options);
		model = options.model || firstModelId(modelsResponse.body);

		if (!model) {
			throw new CliError(
				'No model was provided and GET /models did not return a usable model id',
			);
		}

		completion = await completeWithContinuations(
			options,
			model,
			prompt,
			context.systemPrompt,
		);
	} catch (error) {
		await writeRunFailure(runDir, {
			baseUrl: options.baseUrl,
			context,
			error,
			model: model || options.model || '',
			prompt,
			responsePath,
		});
		throw new CliError(
			`Model run failed: ${error.message}. Artifacts: ${runDir}`,
		);
	}

	const summary = {
		artifacts: {
			context: 'context.md',
			messages: 'messages.json',
			prompt: 'prompt.md',
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
		promptChars: prompt.length,
		responseChars: completion.text.length,
		responseCount: completion.responses.length,
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
	const summary = {
		artifacts: {
			context: 'context.md',
			error: 'error.json',
			messages: 'messages.json',
			prompt: 'prompt.md',
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
		promptChars: details.prompt.length,
		responseChars: 0,
		responseCount: 0,
		taskCounts: taskCounts(taskPlan),
		workspaceFileCount: details.context.files.length,
	};

	await writeText(details.responsePath, '');
	await writeJson(join(runDir, 'messages.json'), []);
	await writeText(join(runDir, 'scratchpad.md'), '');
	await writeJson(join(runDir, 'error.json'), error);
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
			messages: messages.map((message) => {
				if (
					!message ||
					typeof message.level !== 'string' ||
					typeof message.content !== 'string'
				) {
					throw new CliError(
						'Proposal messages must have string level and content',
					);
				}

				return {
					content: message.content,
					level: message.level,
				};
			}),
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

function proposalPaths(proposal) {
	return [
		...proposal.files.map((file) => file.path),
		...proposal.patches.map((patch) => patch.path),
	];
}

async function completeWithContinuations(options, model, prompt, systemPrompt) {
	const budget = createLoopBudget({
		maxCostUsd: options.maxCostUsd,
		maxRetries: options.maxRetries,
		maxTokens: options.maxTokens,
		maxTurns: options.maxTurns,
	});
	const responses = [];
	const finishReasons = [];
	const chunks = [];
	const messages = [
		{
			content: systemPrompt,
			role: 'system',
		},
		{
			content: prompt,
			role: 'user',
		},
	];

	while (true) {
		budget.beforeTurn();
		const chatResponse = await createChatCompletion(options, {
			messages,
			model,
			temperature: 0,
		});
		budget.recordUsage(chatResponse.body?.usage);
		const content = firstAssistantMessage(chatResponse.body);
		if (!content) {
			throw new CliError(
				'POST /chat/completions did not return a usable assistant message',
			);
		}

		const finishReason = firstFinishReason(chatResponse.body);
		responses.push(chatResponse.body);
		finishReasons.push(finishReason);
		chunks.push(content);

		if (finishReason !== 'length') {
			budget.stop(finishReason ? `finish_${finishReason}` : 'finish_unknown');
			return {
				finishReasons,
				loopBudget: budget.snapshot(),
				responses,
				text: chunks.join(''),
			};
		}

		budget.recordRetry();
		messages.push({
			content,
			role: 'assistant',
		});
		messages.push({
			content: 'Continue from exactly where you stopped.',
			role: 'user',
		});
	}
}
