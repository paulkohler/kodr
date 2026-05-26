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
import { jailedPath, prepareWrites } from './safe-writes.mjs';
import { discoverSkills, loadSkills, renderSkillIndex } from './skills.mjs';
import { runVerification } from './verification-runner.mjs';
import { replayRun } from './replay.mjs';

export const VERSION = '0.0.0';

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_TIMEOUT_MS = 600000;
const PROBE_PROMPT = 'Reply with exactly: koder-probe-ok';

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
		help: false,
		json: false,
		model: env.MODEL_ID || '',
		out: '',
		apiKey: env.OPENAI_API_KEY || '',
		prompt: '',
		promptFile: '',
		replayDir: '',
		showContext: false,
		showFiles: false,
		showSkills: false,
		skills: [],
		testCommand: '',
		testCwd: '',
		timeoutMs: DEFAULT_TIMEOUT_MS,
		version: false,
		yes: false,
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
			arg === '--timeout-ms'
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

	if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100) {
		throw new CliError(
			'--timeout-ms must be an integer greater than or equal to 100',
		);
	}

	return options;
}

export function usage() {
	return `koder ${VERSION}

Usage:
  koder --help
  koder --version
  koder probe [--json]
  koder run -p "task" [--json]
  koder run --prompt-file prompt.md [--out .koder/runs/name]
  koder run -p "task" --dry-run
  koder run -p "task" --yes [--test "npm test"] [--test-cwd path]
  koder run --show-files
  koder run --show-context
  koder run --show-skills
  koder replay <run-dir>

Local-model defaults:
  --base-url URL       Default: ${DEFAULT_BASE_URL}
  --model ID           Default: MODEL_ID
  --api-key KEY        Default: OPENAI_API_KEY
  --timeout-ms N       Default: ${DEFAULT_TIMEOUT_MS}

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
			const context = await buildWorkspaceContext(io.cwd);
			io.stdout.write(renderContextMarkdown(context));
			return { ok: true, command: 'run', context };
		}

		const result = await runPrompt(options, io);
		if (options.json) {
			io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		} else {
			io.stdout.write(`Run ok\n`);
			io.stdout.write(`Run: ${result.runDir}\n`);
			io.stdout.write(`Model: ${result.model}\n`);
			io.stdout.write(`Response: ${result.responsePath}\n`);
		}
		return { ok: result.ok, command: 'run', result };
	}

	if (options.command === 'replay') {
		if (!options.replayDir) {
			throw new CliError('koder replay requires a run directory');
		}
		const replayDir = await jailedPath(io.cwd, options.replayDir);
		const result = await replayRun(replayDir.absolute);
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return { ok: true, command: 'replay', result };
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
	const context = await buildWorkspaceContext(io.cwd, { skills });
	const modelsResponse = await listModels(options);
	const model = options.model || firstModelId(modelsResponse.body);

	if (!model) {
		throw new CliError(
			'No model was provided and GET /models did not return a usable model id',
		);
	}

	const completion = await completeWithContinuations(
		options,
		model,
		prompt,
		context.systemPrompt,
	);
	const responsePath = join(runDir, 'response.md');
	const summary = {
		artifacts: {
			context: 'context.md',
			prompt: 'prompt.md',
			rawResponse: 'raw-response.json',
			response: 'response.md',
			summary: 'summary.json',
			tests: 'tests.json',
			writes: 'writes.json',
		},
		baseUrl: options.baseUrl,
		finishReasons: completion.finishReasons,
		model,
		ok: true,
		promptChars: prompt.length,
		responseChars: completion.text.length,
		responseCount: completion.responses.length,
		workspaceFileCount: context.files.length,
	};
	const proposal = extractProposal(completion.text);
	const writeResult = proposal
		? await prepareWrites(io.cwd, proposal.files, { apply: options.yes })
		: {
				applied: false,
				writes: [],
			};
	const testResult =
		options.testCommand && options.yes
			? await runVerification(
					await verificationCwd(io.cwd, options),
					options.testCommand,
					{
						timeoutMs: options.timeoutMs,
					},
				)
			: null;

	summary.applied = writeResult.applied;
	summary.ok = testResult ? testResult.ok : true;
	summary.proposalFound = proposal !== null;
	summary.tested = testResult !== null;
	summary.writeCount = writeResult.writes.length;

	await writeText(join(runDir, 'context.md'), renderContextMarkdown(context));
	await writeText(join(runDir, 'prompt.md'), prompt);
	await writeText(responsePath, completion.text);
	await writeJson(join(runDir, 'raw-response.json'), {
		responses: completion.responses,
	});
	await writeJson(join(runDir, 'summary.json'), summary);
	await writeJson(join(runDir, 'writes.json'), writeResult);
	await writeJson(join(runDir, 'tests.json'), testResult);

	return {
		...summary,
		proposal,
		response: completion.text,
		responsePath,
		runDir,
		testResult,
		writeResult,
	};
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

	throw new CliError('koder run requires -p/--prompt or --prompt-file');
}

function extractProposal(text) {
	try {
		const value = extractJson(text);
		if (!value || !Array.isArray(value.files)) {
			return null;
		}

		return {
			files: value.files.map((file) => {
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
		};
	} catch (error) {
		if (error instanceof JsonExtractionError) {
			return null;
		}
		throw error;
	}
}

async function completeWithContinuations(options, model, prompt, systemPrompt) {
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

	for (let index = 0; index < 8; index += 1) {
		const chatResponse = await createChatCompletion(options, {
			messages,
			model,
			temperature: 0,
		});
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
			return {
				finishReasons,
				responses,
				text: chunks.join(''),
			};
		}

		messages.push({
			content,
			role: 'assistant',
		});
		messages.push({
			content: 'Continue from exactly where you stopped.',
			role: 'user',
		});
	}

	throw new CliError('Continuation limit reached before the model stopped');
}
