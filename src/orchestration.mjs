import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson, writeText } from './artifacts.mjs';
import {
	buildWorkspaceContext,
	renderContextMarkdown,
} from './context-packer.mjs';
import { extractJson, extractProposal } from './json-extractor.mjs';
import { prepareChanges } from './safe-writes.mjs';
import {
	completeWithToolCalls,
	createBuiltinRegistry,
	ToolRegistry,
} from './tool-calls.mjs';
import { listContextFiles } from './context-packer.mjs';
import { jailedPath } from './safe-writes.mjs';

const AGENTS = ['planner', 'implementer', 'reviewer'];

export async function runSubagentStages(cwd, runDir, prompt, options, io = {}) {
	const workspaceContext =
		options.workspaceContext ||
		(await buildWorkspaceContext(cwd, { toolsMode: true }));
	const subagentRoot = join(runDir, 'subagents');
	const commandRunner = options.commandRunner || null;

	const planner = await runPlannerAgent(
		cwd,
		join(subagentRoot, 'planner'),
		prompt,
		workspaceContext,
		options,
	);
	const implementer = await runImplementerAgent(
		cwd,
		join(subagentRoot, 'implementer'),
		prompt,
		planner.plan,
		workspaceContext,
		options,
	);

	let writeResult = {
		applied: false,
		writes: [],
	};
	let writeError = null;
	try {
		writeResult = implementer.proposal
			? await prepareChanges(cwd, implementer.proposal, {
					apply: options.yes,
					protectExisting: options.protectExisting,
				})
			: writeResult;
	} catch (error) {
		writeError = { message: error.message, name: error.name };
		writeResult = { applied: false, error: writeError, writes: [] };
	}

	const reviewer = await runReviewerAgent(
		cwd,
		join(subagentRoot, 'reviewer'),
		prompt,
		planner.plan,
		implementer.proposal,
		{
			...options,
			commandRunner,
		},
	);

	const responses = [
		...planner.completion.responses,
		...implementer.completion.responses,
		...reviewer.completion.responses,
	];
	const loopBudget = mergeLoopBudgets(responses);
	const orchestration = {
		agents: {
			planner: {
				artifactDir: relativeArtifact(runDir, planner.artifactDir),
				planChars: planner.plan.length,
			},
			implementer: {
				artifactDir: relativeArtifact(runDir, implementer.artifactDir),
				proposalFound: implementer.proposal !== null,
			},
			reviewer: {
				artifactDir: relativeArtifact(runDir, reviewer.artifactDir),
				pass: reviewer.review.pass,
				issueCount: reviewer.review.issues.length,
			},
		},
		ok: !writeError && reviewer.review.pass,
		plan: planner.plan,
		review: reviewer.review,
		writeCount: writeResult.writes.length,
	};
	await writeJson(join(runDir, 'orchestration.json'), orchestration);

	if (!reviewer.review.pass && io.stderr?.write) {
		io.stderr.write(
			`Reviewer blocked completion: ${reviewer.review.summary}\n`,
		);
		for (const issue of reviewer.review.issues) {
			io.stderr.write(`- ${issue}\n`);
		}
	}

	return {
		applied: writeResult.applied,
		messages: [
			...planner.completion.messages,
			...implementer.completion.messages,
			...reviewer.completion.messages,
		],
		finishReasons: [
			...planner.completion.finishReasons,
			...implementer.completion.finishReasons,
			...reviewer.completion.finishReasons,
		],
		loopBudget,
		ok: orchestration.ok,
		orchestration,
		proposal: implementer.proposal,
		proposalFound: implementer.proposal !== null,
		proposalStatus: implementer.proposal?.status || '',
		response: implementer.completion.text,
		responses,
		review: reviewer.review,
		tested: false,
		writeCount: writeResult.writes.length,
		writeError,
		writeResult,
	};
}

export async function runPlannerAgent(
	cwd,
	subDir,
	prompt,
	workspaceContext,
	agentOptions,
) {
	const systemPrompt = await buildAgentSystemPrompt('planner');
	const userPrompt = renderAgentUserPrompt('planner', prompt, [
		'## Workspace context',
		renderContextMarkdown(workspaceContext),
	]);
	const registry = createReadOnlyRegistry(cwd);
	const completion = await runAgentCompletion({
		agentName: 'planner',
		agentOptions,
		registry,
		subDir,
		systemPrompt,
		userPrompt,
	});
	const plan = completion.text.trim();
	const result = { plan };
	await writeJson(join(subDir, 'result.json'), result);
	return {
		artifactDir: subDir,
		completion,
		plan,
	};
}

export async function runImplementerAgent(
	cwd,
	subDir,
	prompt,
	plan,
	workspaceContext,
	agentOptions,
) {
	const systemPrompt = await buildAgentSystemPrompt('implementer', [
		'## Plan',
		plan,
	]);
	const userPrompt = renderAgentUserPrompt('implementer', prompt, [
		'## Workspace context',
		renderContextMarkdown(workspaceContext),
		'## Plan',
		plan,
	]);
	const registry = createBuiltinRegistry(cwd, {
		commandRunner: agentOptions.commandRunner || null,
		hooks: agentOptions.hooks || null,
	});
	const completion = await runAgentCompletion({
		agentName: 'implementer',
		agentOptions,
		registry,
		subDir,
		systemPrompt,
		userPrompt,
	});
	const proposal = extractProposal(completion.text);
	await writeJson(join(subDir, 'proposal.json'), proposal);
	return {
		artifactDir: subDir,
		completion,
		proposal,
	};
}

export async function runReviewerAgent(
	cwd,
	subDir,
	prompt,
	plan,
	proposal,
	agentOptions,
) {
	const systemPrompt = await buildAgentSystemPrompt('reviewer', [
		'## Plan',
		plan,
		'## Proposed writes',
		JSON.stringify(proposal || { files: [], patches: [] }, null, 2),
	]);
	const userPrompt = renderAgentUserPrompt('reviewer', prompt, [
		'## Plan',
		plan,
		'## Proposed writes',
		JSON.stringify(proposal || { files: [], patches: [] }, null, 2),
		agentOptions.testCommand
			? `## Test command\nUse run_command with: ${agentOptions.testCommand}`
			: '',
	]);
	const registry = createBuiltinRegistry(cwd, {
		commandRunner: agentOptions.commandRunner || null,
		hooks: agentOptions.hooks || null,
	});
	const completion = await runAgentCompletion({
		agentName: 'reviewer',
		agentOptions,
		registry,
		subDir,
		systemPrompt,
		userPrompt,
	});
	const review = extractReview(completion.text);
	await writeJson(join(subDir, 'result.json'), review);
	return {
		artifactDir: subDir,
		completion,
		review,
	};
}

export function splitAgentDirectives(prompt) {
	const result = {
		basePrompt: [],
		directives: Object.fromEntries(AGENTS.map((agent) => [agent, []])),
	};
	for (const line of prompt.split('\n')) {
		const match = /^(planner|implementer|reviewer)\s*:\s*(.*)$/iu.exec(
			line.trim(),
		);
		if (match) {
			result.directives[match[1].toLowerCase()].push(match[2]);
		} else {
			result.basePrompt.push(line);
		}
	}
	return {
		basePrompt: result.basePrompt.join('\n').trim(),
		directives: result.directives,
	};
}

async function runAgentCompletion({
	agentName,
	agentOptions,
	registry,
	subDir,
	systemPrompt,
	userPrompt,
}) {
	await mkdir(subDir, { recursive: true });
	await writeJson(join(subDir, 'request.json'), {
		agent: agentName,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
		model: agentOptions.model,
		tools: registry.toApiTools(),
	});
	const completion = await completeWithToolCalls(
		agentOptions,
		agentOptions.model,
		userPrompt,
		systemPrompt,
		registry,
	);
	await writeText(join(subDir, 'response.md'), completion.text);
	await writeJson(join(subDir, 'messages.json'), completion.messages);
	await writeJson(join(subDir, 'raw-response.json'), {
		loopBudget: completion.loopBudget,
		responses: completion.responses,
	});
	return completion;
}

async function buildAgentSystemPrompt(agentName, sections = []) {
	const prompt = await readFile(
		new URL(`../prompts/orchestration-${agentName}.md`, import.meta.url),
		'utf8',
	);
	return [renderAgentRoster(agentName), prompt.trim(), ...sections]
		.filter(Boolean)
		.join('\n\n');
}

function renderAgentRoster(agentName) {
	return `## Subagent Pipeline

This run uses three subagent stages:

- **planner** — explores the codebase and writes an implementation plan.
  Receives: the user prompt and workspace file list.
- **implementer** — reads files and writes code following the plan.
  Receives: the plan from the planner.
- **reviewer** — checks correctness and completeness, may run tests.
  Receives: the plan and the proposed changes.

You are the **${agentName}** agent. Instructions targeted at you start with
\`${agentName}:\` in the user prompt.`;
}

function renderAgentUserPrompt(agentName, prompt, sections = []) {
	const parsed = splitAgentDirectives(prompt);
	const directives = parsed.directives[agentName];
	return [
		parsed.basePrompt,
		directives.length > 0
			? `## Instructions targeted at ${agentName}\n${directives.join('\n')}`
			: '',
		...sections,
	]
		.filter(Boolean)
		.join('\n\n');
}

function createReadOnlyRegistry(cwd) {
	const registry = new ToolRegistry({ cwd });
	registry.register('list_files', {
		description: 'List files available in the workspace.',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		handler: async () => listContextFiles(cwd),
	});
	registry.register('read_file', {
		description: 'Read the text content of a workspace file.',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Path relative to the workspace root.',
				},
			},
			required: ['path'],
			additionalProperties: false,
		},
		handler: async ({ path }) => {
			const jailed = await jailedPath(cwd, path);
			return readFile(jailed.absolute, 'utf8');
		},
	});
	return registry;
}

function normalizeReview(value) {
	return {
		issues: Array.isArray(value?.issues)
			? value.issues.map((issue) =>
					typeof issue === 'string' ? issue : JSON.stringify(issue),
				)
			: [],
		pass: value?.pass === true,
		summary: typeof value?.summary === 'string' ? value.summary : '',
	};
}

function extractReview(text) {
	try {
		return normalizeReview(extractJson(text));
	} catch (error) {
		return {
			issues: [`Reviewer did not return valid review JSON: ${error.message}`],
			pass: false,
			summary: 'Reviewer output could not be parsed.',
		};
	}
}

function mergeLoopBudgets(responses) {
	const usage = responses.reduce(
		(total, response) => {
			const current = response.usage || {};
			total.promptTokens += current.prompt_tokens || current.promptTokens || 0;
			total.completionTokens +=
				current.completion_tokens || current.completionTokens || 0;
			total.tokens += current.total_tokens || current.tokens || 0;
			total.cost += current.cost || 0;
			total.costUsd += current.costUsd || current.cost_usd || current.cost || 0;
			return total;
		},
		{ completionTokens: 0, cost: 0, costUsd: 0, promptTokens: 0, tokens: 0 },
	);
	return {
		...usage,
		maxCostUsd: null,
		maxRetries: 0,
		maxTokens: null,
		maxTurns: null,
		retries: 0,
		stopReason: 'subagent_stages',
		turns: responses.length,
	};
}

function relativeArtifact(runDir, artifactDir) {
	return artifactDir.startsWith(`${runDir}/`)
		? artifactDir.slice(runDir.length + 1)
		: artifactDir;
}
