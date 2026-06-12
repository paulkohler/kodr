import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson, writeText } from './artifacts.mjs';
import { getBuiltinSkill } from './builtin-skills.mjs';
import {
	buildWorkspaceContext,
	renderKodrCorePrompt,
	renderContextMarkdown,
	summarizePromptSections,
} from './context-packer.mjs';
import { extractJson, extractProposal } from './json-extractor.mjs';
import { runDependencyInstall } from './dependency-installer.mjs';
import { emitProgress, runStartHook } from './progress.mjs';
import { prepareChanges } from './safe-writes.mjs';
import {
	plannerResponseFormat,
	proposalResponseFormat,
	reviewResponseFormat,
	responseFormatForRequest,
} from './structured-output.mjs';
import {
	completeWithToolCalls,
	createBuiltinRegistry,
	ToolRegistry,
} from './tool-calls.mjs';
import { buildChatRequestBody } from './model-client.mjs';
import { listContextFiles } from './context-packer.mjs';
import { jailedPath } from './safe-writes.mjs';
import {
	resolveVerificationCommand,
	runVerification,
} from './verification-runner.mjs';

const AGENTS = ['planner', 'implementer', 'file-author', 'reviewer'];

// Replace the concatenated planner/implementer/reviewer message arrays with a
// clean user+assistant pair. Continuation turns that load this session then see
// a normal single-agent exchange instead of the subagent-role system messages,
// which prevents the model from mimicking the planner manifest format.
export function synthOrchestrationSessionMessages(plannerMessages, writes) {
	const userMsg = plannerMessages.find((m) => m.role === 'user') ?? {
		content: '',
		role: 'user',
	};
	const changed = writes
		.filter((w) => w.status !== 'skip' && typeof w.path === 'string')
		.map((w) => w.path);
	const summary =
		changed.length > 0
			? `Implemented: ${changed.join(', ')}`
			: 'No file changes were made.';
	const assistantContent = JSON.stringify({
		files: [],
		messages: [{ content: summary, level: 'info' }],
		patches: [],
		scratchpad: '',
		status: 'OK',
	});
	return [userMsg, { content: assistantContent, role: 'assistant' }];
}

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
		{
			...options,
			planManifest: planner.manifest,
		},
	);

	let writeResult = {
		applied: false,
		writes: [],
	};
	let writeError = null;
	if (!implementer.proposal) {
		writeError = {
			message: 'Implementer response did not include a proposal',
			name: 'ProposalMissingError',
		};
		writeResult = { applied: false, error: writeError, writes: [] };
	} else if (implementer.proposal.status === 'ERROR') {
		writeError = {
			message:
				implementer.proposal.messages
					.map((message) => message.content)
					.filter(Boolean)
					.join('\n') || 'Implementer returned status ERROR',
			name: 'ProposalStatusError',
		};
		writeResult = { applied: false, error: writeError, writes: [] };
	}
	try {
		writeResult = !writeError
			? await prepareChanges(cwd, implementer.proposal, {
					apply: options.yes,
					protectExisting: options.protectExisting,
					protectedPaths: options.protectedPaths,
				})
			: writeResult;
	} catch (error) {
		writeError = { message: error.message, name: error.name };
		writeResult = { applied: false, error: writeError, writes: [] };
	}

	const verificationRoot = await orchestrationVerificationCwd(cwd, options);
	const installResult =
		options.installDependencies &&
		options.yes &&
		!writeError &&
		(await fileExists(join(verificationRoot, 'package.json')))
			? await runDependencyInstall(verificationRoot, {
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
	const verification = await runOrchestrationVerification(
		verificationRoot,
		options,
		commandRunner,
		writeError || runError,
	);
	await writeJson(join(runDir, 'install.json'), installResult);
	await writeJson(join(runDir, 'tests.json'), verification?.result || null);

	// The reviewer is advisory: deterministic verification is the authoritative
	// signal. A reviewer model error or timeout must not crash the run and
	// discard a successful implement/install/verify, so treat it as
	// "review unavailable" rather than a hard failure. It can also be skipped.
	const reviewerDir = join(subagentRoot, 'reviewer');
	let reviewer;
	if (options.skipReview) {
		reviewer = await makeUnavailableReviewer(
			reviewerDir,
			optionsForAgent({ ...options, commandRunner }, 'reviewer'),
			{ name: 'ReviewSkipped', message: 'reviewer skipped (--no-review)' },
		);
	} else {
		const reviewerOptions = {
			...options,
			commandRunner,
			...(options.reviewTimeoutMs
				? { timeoutMs: options.reviewTimeoutMs }
				: {}),
		};
		try {
			reviewer = await runReviewerAgent(
				cwd,
				reviewerDir,
				prompt,
				planner.plan,
				{
					verification,
					workspaceContext,
					writeResult,
				},
				reviewerOptions,
			);
		} catch (error) {
			reviewer = await makeUnavailableReviewer(
				reviewerDir,
				optionsForAgent(reviewerOptions, 'reviewer'),
				error,
			);
		}
	}

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
				manifestFiles: planner.manifest?.files?.length ?? null,
				model: planner.model,
				modelProfile: planner.modelProfile || null,
				planChars: planner.plan.length,
				provider: planner.provider,
			},
			implementer: {
				artifactDir: relativeArtifact(runDir, implementer.artifactDir),
				manifestCount: implementer.manifest?.length || 0,
				missingFiles: implementer.remaining || [],
				model: implementer.model,
				modelProfile: implementer.modelProfile || null,
				proposalFound: implementer.proposal !== null,
				provider: implementer.provider,
			},
			reviewer: {
				artifactDir: relativeArtifact(runDir, reviewer.artifactDir),
				pass: reviewer.review.pass,
				issueCount: reviewer.review.issues.length,
				model: reviewer.model,
				modelProfile: reviewer.modelProfile || null,
				provider: reviewer.provider,
				unavailable: reviewer.review.unavailable === true,
			},
		},
		install: installResult,
		ok:
			!writeError &&
			!runError &&
			(!verification?.result || verification.result.ok) &&
			(reviewer.review.pass || reviewer.review.unavailable === true),
		plan: planner.plan,
		review: reviewer.review,
		verification,
		writeCount: writeResult.writes.length,
	};
	await writeJson(join(runDir, 'orchestration.json'), orchestration);

	if (reviewer.review.unavailable === true && io.stderr?.write) {
		io.stderr.write(
			`Reviewer unavailable (${reviewer.review.summary}); relying on deterministic verification.\n`,
		);
	} else if (!reviewer.review.pass && io.stderr?.write) {
		io.stderr.write(
			`Reviewer blocked completion: ${reviewer.review.summary}\n`,
		);
		for (const issue of reviewer.review.issues) {
			io.stderr.write(`- ${issue}\n`);
		}
	}

	return {
		applied: writeResult.applied,
		messages: synthOrchestrationSessionMessages(
			planner.completion.messages,
			writeResult.writes,
		),
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
		installResult,
		runError,
		tested: Boolean(verification?.result),
		testResult: verification?.result || null,
		verification,
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
	const activeOptions = optionsForAgent(agentOptions, 'planner');
	const registry = createReadOnlyRegistry(cwd);
	const systemPrompt = await buildAgentSystemPrompt(
		'planner',
		workspaceContext,
		registry,
	);
	const userPrompt = renderAgentUserPrompt('planner', prompt, [
		'## Workspace context',
		renderContextMarkdown(workspaceContext),
	]);
	const completion = await runAgentCompletion({
		agentName: 'planner',
		agentOptions: {
			...activeOptions,
			responseFormat: plannerResponseFormat(),
		},
		registry,
		subDir,
		systemPrompt,
		userPrompt,
	});
	const plan = completion.text.trim();
	const manifest = parsePlanManifest(plan);
	const result = { manifest, plan };
	await writeJson(join(subDir, 'result.json'), result);
	if (manifest) {
		await writeJson(join(subDir, 'manifest.json'), manifest);
	}
	return {
		artifactDir: subDir,
		completion,
		manifest,
		model: activeOptions.model,
		modelProfile: activeOptions.modelProfile || null,
		plan,
		provider: activeOptions.provider,
	};
}

// Upper bound on implementer turns. Small local models cannot emit a whole
// multi-file project in one proposal, so when the plan names several target
// files Kodr drives the implementer file-by-file until the plan's manifest is
// satisfied or progress stalls. Local implementer passes are typically cost-0,
// so the cap favors completing a multi-file manifest.
const MAX_IMPLEMENTER_PASSES = 8;
// How many consecutive passes may add no new files before Kodr gives up. A weak
// model often spends its first turn on an intention/empty proposal, so a single
// barren pass must not end the loop.
const MAX_NO_PROGRESS_PASSES = 2;

export async function runImplementerAgent(
	cwd,
	subDir,
	prompt,
	plan,
	workspaceContext,
	agentOptions,
) {
	const structuredManifest =
		agentOptions.planManifest || parsePlanManifest(plan);
	if (structuredManifest && structuredManifest.files.length > 0) {
		return runIsolatedFileAuthors(
			cwd,
			subDir,
			prompt,
			structuredManifest,
			workspaceContext,
			agentOptions,
		);
	}

	const activeOptions = optionsForAgent(agentOptions, 'implementer');
	const registry = createBuiltinRegistry(cwd, {
		commandRunner: activeOptions.commandRunner || null,
		hooks: activeOptions.hooks || null,
		runDir: subDir,
		skillExecutor: activeOptions.skillExecutor || null,
		timeoutMs: activeOptions.timeoutMs,
	});
	const systemPrompt = await buildAgentSystemPrompt(
		'implementer',
		workspaceContext,
		registry,
	);

	const manifest = extractPlanManifest(plan);
	const maxPasses =
		manifest.length > 1 ? Math.min(manifest.length, MAX_IMPLEMENTER_PASSES) : 1;

	const completions = [];
	let merged = null;
	let remaining = manifest.slice();
	let pass = 0;
	let noProgressStreak = 0;

	while (pass < maxPasses) {
		pass += 1;
		const passDir = pass === 1 ? subDir : join(subDir, `pass-${pass}`);
		const sections = [
			'## Workspace context',
			renderContextMarkdown(workspaceContext),
			'## Plan',
			plan,
		];
		if (pass > 1) {
			const done = manifest.filter((path) => !remaining.includes(path));
			sections.push(
				'## Already implemented',
				done.length > 0
					? done.map((path) => `- ${path}`).join('\n')
					: '- (none)',
				'## Remaining files to implement',
				remaining.map((path) => `- ${path}`).join('\n'),
				'Return a JSON proposal whose `files` array holds the full contents of the remaining files listed above. Do not resend already-implemented files. Do not return an empty proposal or intention-only messages — write the files now.',
			);
		}
		const userPrompt = renderAgentUserPrompt('implementer', prompt, sections);
		const completion = await runAgentCompletion({
			agentName: 'implementer',
			agentOptions: {
				...activeOptions,
				// E4: implementer must return a JSON proposal envelope.
				nudgeEmptyTurn: true,
				responseFormat: proposalResponseFormat(),
			},
			registry,
			subDir: passDir,
			systemPrompt,
			userPrompt,
		});
		completions.push(completion);

		const proposal = extractProposal(completion.text);
		if (!proposal) {
			// No usable proposal this pass. On the first pass this becomes a
			// missing-proposal failure downstream; later it just ends the loop.
			break;
		}

		const before = merged ? proposalPathCount(merged) : 0;
		merged = mergeProposals(merged, proposal);
		const have = proposalPaths(merged);
		remaining = manifest.filter(
			(path) => !have.has(normalizeManifestPath(path)),
		);
		if (remaining.length === 0) {
			break;
		}
		// An empty or stalled pass is tolerated briefly: weak models often warm
		// up with an intention before producing files. Only stop after several
		// barren passes in a row.
		noProgressStreak =
			proposalPathCount(merged) > before ? 0 : noProgressStreak + 1;
		if (noProgressStreak >= MAX_NO_PROGRESS_PASSES) {
			break;
		}
	}

	await writeJson(join(subDir, 'proposal.json'), merged);
	await writeJson(join(subDir, 'manifest.json'), {
		manifest,
		passes: pass,
		remaining,
	});

	return {
		artifactDir: subDir,
		completion: combineImplementerCompletions(completions),
		manifest,
		model: activeOptions.model,
		modelProfile: activeOptions.modelProfile || null,
		proposal: merged,
		provider: activeOptions.provider,
		remaining,
	};
}

// Pull likely target file paths out of a free-form plan so Kodr can tell when
// the implementer has only delivered part of the work. Heuristic and forgiving:
// over-inclusion costs at most one extra bounded pass, and the progress guard
// stops the loop when a pass adds nothing.
const MANIFEST_EXTENSIONS = new Set([
	'mjs',
	'cjs',
	'js',
	'jsx',
	'ts',
	'tsx',
	'json',
	'md',
	'txt',
	'yml',
	'yaml',
	'toml',
	'sql',
	'html',
	'css',
]);
const MANIFEST_ROOT_FILES = new Set([
	'package.json',
	'readme.md',
	'.gitignore',
	'.npmrc',
	'tsconfig.json',
	'.env.example',
	'docker-compose.yml',
]);

export function parsePlanManifest(text) {
	if (!text || typeof text !== 'string') {
		return null;
	}
	try {
		const value = extractJson(text);
		if (!value || !Array.isArray(value.files)) {
			return null;
		}
		const files = value.files
			.filter((f) => f && typeof f.path === 'string' && f.path)
			.map((f) => ({
				exports: Array.isArray(f.exports)
					? f.exports.filter((e) => typeof e === 'string')
					: [],
				imports: Array.isArray(f.imports)
					? f.imports
							.filter((i) => i && typeof i.from === 'string')
							.map((i) => ({
								from: i.from,
								names: Array.isArray(i.names)
									? i.names.filter((n) => typeof n === 'string')
									: [],
							}))
					: [],
				path: f.path,
				responsibility:
					typeof f.responsibility === 'string' ? f.responsibility : '',
			}));
		if (files.length === 0) {
			return null;
		}
		return {
			files,
			summary: typeof value.summary === 'string' ? value.summary : '',
			verification:
				typeof value.verification === 'string' ? value.verification : null,
		};
	} catch {
		return null;
	}
}

export function extractPlanManifest(plan) {
	if (!plan || typeof plan !== 'string') {
		return [];
	}
	const tokens = plan.split(/[\s`'"()[\]{}<>,;]+/u);
	const seen = new Set();
	const manifest = [];
	for (const raw of tokens) {
		const token = raw.replace(/^\.\//u, '').replace(/[*:.]+$/u, '');
		if (!isManifestPath(token)) {
			continue;
		}
		const key = normalizeManifestPath(token);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		manifest.push(token);
	}
	return manifest;
}

function isManifestPath(token) {
	if (!token || token.includes('://') || token.includes('*')) {
		return false;
	}
	if (token.startsWith('/') || token.includes('..')) {
		return false;
	}
	const lower = token.toLowerCase();
	const dot = lower.lastIndexOf('.');
	if (dot <= 0) {
		return false;
	}
	const ext = lower.slice(dot + 1);
	if (token.includes('/')) {
		return MANIFEST_EXTENSIONS.has(ext);
	}
	return MANIFEST_ROOT_FILES.has(lower);
}

function normalizeManifestPath(path) {
	return path
		.replace(/^\.\//u, '')
		.split(/[\\/]+/u)
		.filter((part) => part !== '' && part !== '.')
		.join('/')
		.toLowerCase();
}

function proposalPaths(proposal) {
	const paths = new Set();
	for (const file of proposal?.files || []) {
		paths.add(normalizeManifestPath(file.path));
	}
	for (const patch of proposal?.patches || []) {
		paths.add(normalizeManifestPath(patch.path));
	}
	return paths;
}

function proposalPathCount(proposal) {
	return proposalPaths(proposal).size;
}

// Accumulate files/patches across passes. The first content for a given path
// wins so a later pass cannot truncate or clobber an already-delivered file.
function mergeProposals(base, next) {
	if (!next) {
		return base;
	}
	if (!base) {
		return {
			files: [...(next.files || [])],
			messages: [...(next.messages || [])],
			patches: [...(next.patches || [])],
			status: next.status || 'OK',
		};
	}
	const filePaths = new Set(base.files.map((file) => file.path));
	for (const file of next.files || []) {
		if (!filePaths.has(file.path)) {
			base.files.push(file);
			filePaths.add(file.path);
		}
	}
	const patchKeys = new Set(
		base.patches.map((patch) => `${patch.path}\u0000${patch.search}`),
	);
	for (const patch of next.patches || []) {
		const key = `${patch.path}\u0000${patch.search}`;
		if (!patchKeys.has(key)) {
			base.patches.push(patch);
			patchKeys.add(key);
		}
	}
	base.messages.push(...(next.messages || []));
	return base;
}

function combineImplementerCompletions(completions) {
	if (completions.length === 1) {
		return completions[0];
	}
	const responses = completions.flatMap(
		(completion) => completion.responses || [],
	);
	return {
		finishReasons: completions.flatMap(
			(completion) => completion.finishReasons || [],
		),
		loopBudget: mergeLoopBudgets(responses),
		messages: completions.flatMap((completion) => completion.messages || []),
		responses,
		text: completions
			.map((completion) => completion.text)
			.filter(Boolean)
			.join('\n\n'),
	};
}

async function runIsolatedFileAuthors(
	cwd,
	subDir,
	prompt,
	structuredManifest,
	workspaceContext,
	agentOptions,
) {
	const completions = [];
	let merged = null;

	for (let i = 0; i < structuredManifest.files.length; i += 1) {
		const entry = structuredManifest.files[i];
		const authorSubDir = join(subDir, `author-${i}`);
		const result = await runFileAuthorAgent(
			cwd,
			authorSubDir,
			prompt,
			entry,
			structuredManifest,
			workspaceContext,
			agentOptions,
		);
		completions.push(result.completion);
		if (result.proposal) {
			merged = mergeProposals(merged, result.proposal);
		}
	}

	const manifest = structuredManifest.files.map((f) => f.path);
	const have = proposalPaths(merged || {});
	const remaining = manifest.filter(
		(path) => !have.has(normalizeManifestPath(path)),
	);

	await writeJson(join(subDir, 'proposal.json'), merged);
	await writeJson(join(subDir, 'manifest.json'), {
		manifest,
		mode: 'isolated',
		passes: structuredManifest.files.length,
		remaining,
	});

	const activeOptions = optionsForAgent(agentOptions, 'implementer');
	return {
		artifactDir: subDir,
		completion: combineImplementerCompletions(completions),
		manifest,
		model: activeOptions.model,
		modelProfile: activeOptions.modelProfile || null,
		proposal: merged,
		provider: activeOptions.provider,
		remaining,
	};
}

export async function runFileAuthorAgent(
	cwd,
	subDir,
	prompt,
	entry,
	manifest,
	workspaceContext,
	agentOptions,
) {
	const activeOptions = optionsForAgent(agentOptions, 'file-author');
	const registry = createBuiltinRegistry(cwd, {
		commandRunner: activeOptions.commandRunner || null,
		hooks: activeOptions.hooks || null,
		runDir: subDir,
		skillExecutor: activeOptions.skillExecutor || null,
		timeoutMs: activeOptions.timeoutMs,
	});
	const systemPrompt = await buildAgentSystemPrompt(
		'file-author',
		workspaceContext,
		registry,
	);

	let existingContent = null;
	try {
		const jailed = await jailedPath(cwd, entry.path);
		existingContent = await readFile(jailed.absolute, 'utf8');
	} catch {
		// new file — no existing content
	}

	const userPrompt = renderFileAuthorUserPrompt(
		prompt,
		entry,
		manifest,
		workspaceContext,
		existingContent,
	);

	const completion = await runAgentCompletion({
		agentName: 'file-author',
		agentOptions: {
			...activeOptions,
			// E4: file-author must return a JSON proposal envelope.
			nudgeEmptyTurn: true,
			responseFormat: proposalResponseFormat(),
		},
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
		model: activeOptions.model,
		modelProfile: activeOptions.modelProfile || null,
		proposal,
		provider: activeOptions.provider,
	};
}

function renderFileAuthorUserPrompt(
	prompt,
	entry,
	manifest,
	workspaceContext,
	existingContent,
) {
	const parsed = splitAgentDirectives(prompt);
	const directives = parsed.directives['file-author'] || [];

	const siblings = manifest.files.filter((f) => f.path !== entry.path);

	const exportsText =
		entry.exports.length > 0
			? entry.exports.map((e) => `- ${e}`).join('\n')
			: '(none declared)';

	const importsText =
		entry.imports.length > 0
			? entry.imports
					.map((imp) => `- from \`${imp.from}\`: ${imp.names.join(', ')}`)
					.join('\n')
			: '(none)';

	const siblingSignatures =
		siblings.length > 0
			? siblings
					.map((f) => {
						const sExports =
							f.exports.length > 0
								? f.exports.map((e) => `  - ${e}`).join('\n')
								: '  (none declared)';
						return `### ${f.path}\n${sExports}`;
					})
					.join('\n\n')
			: '(no sibling files in plan)';

	const sections = [
		parsed.basePrompt,
		directives.length > 0
			? `## Instructions targeted at file-author\n${directives.join('\n')}`
			: '',
		'## Workspace context',
		renderContextMarkdown(workspaceContext),
		'## Plan summary',
		manifest.summary || '(see workspace context)',
		'## Your file contract',
		[
			`**Path:** ${entry.path}`,
			`**Responsibility:** ${entry.responsibility}`,
			'',
			'**Exports to provide:**',
			exportsText,
			'',
			'**Imports from siblings:**',
			importsText,
		].join('\n'),
		'## Sibling export signatures',
		siblingSignatures,
	];

	if (existingContent !== null) {
		sections.push(
			'## Existing file content',
			`\`\`\`\n${existingContent}\n\`\`\``,
		);
	}

	return sections.filter(Boolean).join('\n\n');
}

export async function runReviewerAgent(
	cwd,
	subDir,
	prompt,
	plan,
	reviewContext,
	agentOptions,
) {
	const activeOptions = optionsForAgent(agentOptions, 'reviewer');
	const registry = createReadOnlyRegistry(cwd);
	const systemPrompt = await buildAgentSystemPrompt(
		'reviewer',
		reviewContext?.workspaceContext || agentOptions.workspaceContext || null,
		registry,
	);
	const userPrompt = renderAgentUserPrompt('reviewer', prompt, [
		'## Plan',
		plan,
		'## Write manifest',
		renderWriteManifest(reviewContext?.writeResult),
		'## Verification',
		renderVerificationHandoff(reviewContext?.verification),
	]);
	const completion = await runAgentCompletion({
		agentName: 'reviewer',
		agentOptions: {
			...activeOptions,
			responseFormat: reviewResponseFormat(),
		},
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
		model: activeOptions.model,
		modelProfile: activeOptions.modelProfile || null,
		provider: activeOptions.provider,
		review,
	};
}

// Synthesize a reviewer result for when the reviewer model errored or timed out.
// Marked `unavailable` so it does not block the run: the deterministic
// verification already ran and is the authoritative signal.
async function makeUnavailableReviewer(subDir, activeOptions, error) {
	const review = {
		issues: [],
		pass: false,
		summary: error?.message || 'reviewer model did not complete',
		unavailable: true,
		error: { message: error?.message || '', name: error?.name || 'Error' },
	};
	await mkdir(subDir, { recursive: true });
	await writeJson(join(subDir, 'result.json'), review);
	return {
		artifactDir: subDir,
		completion: {
			finishReasons: [],
			loopBudget: null,
			messages: [],
			responses: [],
			text: '',
		},
		model: activeOptions.model,
		modelProfile: activeOptions.modelProfile || null,
		provider: activeOptions.provider,
		review,
	};
}

export function splitAgentDirectives(prompt) {
	const result = {
		basePrompt: [],
		directives: Object.fromEntries(AGENTS.map((agent) => [agent, []])),
	};
	for (const line of prompt.split('\n')) {
		const match =
			/^(planner|implementer|file-author|reviewer)\s*:\s*(.*)$/iu.exec(
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
	const startedAt = performance.now();
	const progressBase = {
		agent: agentName,
		model: agentOptions.model,
		provider: agentOptions.provider,
		runDir: subDir,
	};
	emitProgress(agentOptions, {
		...progressBase,
		event: 'subagent_start',
		message: `${agentName} started`,
	});
	await runStartHook(agentOptions, 'subagent_start', progressBase);
	const requestBase = {
		agent: agentName,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userPrompt },
		],
		model: agentOptions.model,
		provider: agentOptions.provider,
		tools: registry.toApiTools(),
	};
	const responseFormat = responseFormatForRequest(requestBase, agentOptions);
	if (responseFormat) {
		requestBase.response_format = responseFormat;
	}
	const request = buildChatRequestBody(agentOptions, requestBase);
	await writeJson(join(subDir, 'request.json'), request);
	await writeJson(
		join(subDir, 'prompt-prefix.json'),
		summarizePromptSections({
			project: '',
			semiStable: '',
			stable: systemPrompt,
			volatile: userPrompt,
		}),
	);
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
	emitProgress(agentOptions, {
		...progressBase,
		durationMs: Math.round(performance.now() - startedAt),
		event: 'subagent_finish',
		message: `${agentName} finished`,
		responseChars: completion.text.length,
	});
	return completion;
}

function optionsForAgent(options, agentName) {
	const override = options.agentModels?.[agentName];
	if (!override) {
		return options;
	}
	return {
		...options,
		...override,
		agentModels: options.agentModels,
		commandRunner: options.commandRunner,
		hooks: options.hooks,
		onProgress: options.onProgress,
	};
}

async function buildAgentSystemPrompt(agentName, workspaceContext, registry) {
	let prompt;
	try {
		prompt = getBuiltinSkill(`role:${agentName}`).body;
	} catch {
		// Fall back to prompt file for roles not yet in the bundle.
		prompt = await readFile(
			new URL(`../prompts/orchestration-${agentName}.md`, import.meta.url),
			'utf8',
		);
	}
	const core = renderKodrCorePrompt(workspaceContext || {}, {
		includeMemoryContent: false,
		includeWorkspaceInstructionContent: false,
	});
	return [
		core,
		renderAgentRoster(agentName),
		renderAgentToolGuidance(agentName, registry),
		prompt.trim(),
	]
		.filter(Boolean)
		.join('\n\n');
}

function renderAgentRoster(agentName) {
	return `## Subagent Pipeline

This run uses subagent stages:

- **planner** — explores the codebase and emits a structured implementation manifest.
  Receives: the user prompt and workspace file list.
- **file-author** — writes exactly one file from its contract (used when planner emits a structured manifest).
  Receives: plan summary, file contract, and sibling export signatures only.
- **implementer** — reads files and writes code following the plan (fallback when no structured manifest).
  Receives: the plan from the planner.
- **reviewer** — checks correctness and completeness, may run tests.
  Receives: the plan and the proposed changes.

You are the **${agentName}** agent. Instructions targeted at you start with
\`${agentName}:\` in the user prompt.`;
}

function renderAgentToolGuidance(agentName, registry) {
	const names = registry
		.toApiTools()
		.map((tool) => tool.function.name)
		.sort((left, right) => left.localeCompare(right));
	const toolList =
		names.length > 0 ? names.map((name) => `\`${name}\``).join(', ') : 'none';
	return [
		'## Available Tools',
		`The ${agentName} agent can call these native tools: ${toolList}.`,
		'Use the exact tool names shown here; do not invent tool names such as `read` or `write_file`.',
	].join('\n\n');
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

async function runOrchestrationVerification(
	cwd,
	options,
	commandRunner,
	blockingError,
) {
	if (!options.testCommand || !options.yes || blockingError) {
		return null;
	}
	const resolved = await resolveVerificationCommand(cwd, options.testCommand);
	const result = await runVerification(cwd, resolved.command, {
		runner: commandRunner,
		timeoutMs: options.timeoutMs,
	});
	return {
		reason: resolved.reason,
		requestedCommand: resolved.requestedCommand,
		resolvedCommand: resolved.command,
		result: {
			...result,
			reason: resolved.reason,
			requestedCommand: resolved.requestedCommand,
			resolvedCommand: resolved.command,
		},
	};
}

async function orchestrationVerificationCwd(cwd, options) {
	if (!options.testCwd) {
		return cwd;
	}
	return (await jailedPath(cwd, options.testCwd)).absolute;
}

function renderWriteManifest(writeResult) {
	const writes = writeResult?.writes || [];
	if (writes.length === 0) {
		return 'No writes were prepared.';
	}
	const manifest = writes.map((write) => ({
		path: write.path,
		status: write.status,
		...(writeResult.applied ? {} : { diff: capText(write.diff, 4000) }),
	}));
	return JSON.stringify(
		{
			applied: writeResult.applied,
			writes: manifest,
		},
		null,
		2,
	);
}

function renderVerificationHandoff(verification) {
	if (!verification?.result) {
		return 'No deterministic verification command ran.';
	}
	const result = verification.result;
	return JSON.stringify(
		{
			command: result.command,
			ok: result.ok,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			requestedCommand: verification.requestedCommand,
			resolvedCommand: verification.resolvedCommand,
			reason: verification.reason,
			stdout: capText(result.stdout, 2000),
			stderr: capText(result.stderr, 2000),
		},
		null,
		2,
	);
}

function capText(value, maxChars) {
	if (typeof value !== 'string' || value.length <= maxChars) {
		return value || '';
	}
	return `${value.slice(0, maxChars)}\n...[truncated]`;
}

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
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
			const current = normalizeUsageForMerge(response.usage);
			total.promptTokens += current.promptTokens;
			total.completionTokens += current.completionTokens;
			total.tokens += current.tokens;
			total.cachedTokens += current.cachedTokens;
			total.cacheReadTokens += current.cacheReadTokens;
			total.cacheWriteTokens += current.cacheWriteTokens;
			total.cost += current.cost || 0;
			total.costUsd += current.costUsd || current.cost_usd || current.cost || 0;
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
	const budget = {
		...usage,
		maxCostUsd: null,
		maxRetries: 0,
		maxTokens: null,
		maxTurns: null,
		retries: 0,
		stopReason: 'subagent_stages',
		turns: responses.length,
	};
	if (budget.cacheReadTokens === 0) {
		delete budget.cacheReadTokens;
	}
	if (budget.cacheWriteTokens === 0) {
		delete budget.cacheWriteTokens;
	}
	if (budget.cachedTokens === 0) {
		delete budget.cachedTokens;
	}
	return budget;
}

function normalizeUsageForMerge(usage = {}) {
	const promptDetails = usage.prompt_tokens_details || {};
	const promptTokens = Number(
		usage.prompt_tokens || usage.promptTokens || usage.input_tokens || 0,
	);
	const completionTokens = Number(
		usage.completion_tokens ||
			usage.completionTokens ||
			usage.output_tokens ||
			0,
	);
	const tokens = Number(
		usage.total_tokens || usage.tokens || promptTokens + completionTokens,
	);
	const cachedTokens = Number(
		usage.cachedTokens || promptDetails.cached_tokens || 0,
	);
	const cacheReadTokens = Number(
		usage.cacheReadTokens || usage.cache_read_input_tokens || cachedTokens,
	);
	const cacheWriteTokens = Number(
		usage.cacheWriteTokens ||
			usage.cache_creation_input_tokens ||
			promptDetails.cache_write_tokens ||
			0,
	);
	return {
		cacheReadTokens,
		cacheWriteTokens,
		cachedTokens,
		completionTokens,
		cost: Number(usage.cost || 0),
		costUsd: Number(usage.costUsd || usage.cost_usd || usage.cost || 0),
		promptTokens,
		tokens,
	};
}

function relativeArtifact(runDir, artifactDir) {
	return artifactDir.startsWith(`${runDir}/`)
		? artifactDir.slice(runDir.length + 1)
		: artifactDir;
}
