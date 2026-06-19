// run-pipeline.mjs — the core run pipeline: runPrompt and its private helpers
// (staged execution, healing, verification, artifacts, summaries). Extracted
// from app.mjs in phase 148 (app split, Stage D). app.mjs is now a thin
// dispatcher that imports runPrompt (and a few shared helpers) from here and
// re-exports the public ones. maybeCommitAppliedWrites lives here too because
// it is the pipeline's commit step (app.mjs's handleChannelRequest imports it
// back for late-apply commits).

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createRunArtifacts, writeJson, writeText } from './artifacts.mjs';
import { loadConfiguredHooks, writeHookArtifact } from './command-hooks.mjs';
import { CliError, NativeNoProposalError } from './cli-errors.mjs';
import { DEFAULT_REVIEW_TIMEOUT_MS } from './cli/defaults.mjs';
import {
	loadPrompt,
	resolvedAgentsDirs,
	resolvedSkillsDirs,
	workspaceContextOptions,
} from './cli/options.mjs';
import {
	buildWorkspaceContext,
	renderContextMarkdown,
} from './context-packer.mjs';
import { extractProposal } from './json-extractor.mjs';
import {
	buildChatRequestBody,
	firstModelId,
	listModels,
} from './model-client.mjs';
import { loadMemory } from './memory.mjs';
import { SafeWriteError, jailedPath, prepareChanges } from './safe-writes.mjs';
import { createPermissionRequest } from './tools.mjs';
import {
	buildCommitMessage,
	commitAppliedWrites,
	gitTreeState,
} from './git-workspace.mjs';
import { loadSkills } from './skills.mjs';
import {
	AgentError,
	discoverAgents,
	findAgent,
	isOrchestrationRole,
} from './agents.mjs';
import {
	createInspectionTaskPlan,
	createTaskPlan,
	renderInspectionTaskPlan,
	taskCounts,
	updateTasksFromRun,
} from './task-plan.mjs';
import {
	healRepairTurnBudget,
	isNothingGenerated,
	runSelfHealingLoop,
} from './healing.mjs';
import {
	parseVerificationCommand,
	runVerification,
} from './verification-runner.mjs';
import {
	completeWithToolCalls,
	createBuiltinRegistry,
	mergeProposalWithDraft,
} from './tool-calls.mjs';
import { emitProgress, runStartHook } from './progress.mjs';
import {
	proposalResponseFormat,
	responseFormatForRequest,
} from './structured-output.mjs';
import {
	extractEditBlocks,
	mergeBlockPatches,
	renderEditFormatContract,
} from './edit-formats.mjs';
import {
	runSmokeCheckIfNeeded,
	smokeResultToVerification,
} from './smoke-check.mjs';
import {
	runCrossRefSensors,
	runCrossRefSensorsOnProposal,
} from './cross-ref-sensor.mjs';
import { captureEnvironmentFacts } from './system-env.mjs';
import {
	runSyntaxGateIfNeeded,
	syntaxResultToVerification,
} from './syntax-gate.mjs';
import {
	contextBudgetCharsForWindow,
	probeLMStudioContextWindow,
	resolveProbedContextWindow,
	sessionContextCharsForProfile,
} from './model-profiles.mjs';
import { runDependencyInstall } from './dependency-installer.mjs';
import {
	createActiveExecutor,
	executorCommandRunner,
	finalizeExecutor,
	initializeExecutor,
	writeExecutorArtifacts,
} from './active-executor.mjs';
import { completeWithContinuations } from './completion.mjs';
import { derivePromptId, promptIdFromFilename } from './prompt-id.mjs';
import {
	appendCompletionToRawConversation,
	compactSessionConversation,
	loadSessionEvidence,
	sanitizeSessionTail,
} from './session-compaction.mjs';
import { buildHarnessManifest } from './harness.mjs';
import { runPostWriteDiagnostics } from './post-write-sensor.mjs';

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

/**
 * Decide whether the deterministic gates fail a run. Shared by the default and
 * subagent-stages paths so the two stay in lockstep (phase 157).
 *
 * - syntaxFailed: phase-121 syntax gate reported a parse failure.
 * - smokeFailed: phase-156 load probe threw a definitive error (status 'failed').
 *   Inconclusive smoke outcomes ('skipped'/'timeout') never fail the run.
 * - A passing test command overrides both (e.g. heal fixed the file).
 *
 * @param {{syntaxResult: object|null, smokeResult: object|null, testResult: object|null}} args
 * @returns {{syntaxFailed: boolean, smokeFailed: boolean}}
 */
export function deterministicGateOutcome({
	syntaxResult,
	smokeResult,
	testResult,
}) {
	const testPassed = Boolean(testResult && testResult.ok);
	return {
		syntaxFailed:
			Boolean(syntaxResult) && syntaxResult.ok === false && !testPassed,
		smokeFailed:
			Boolean(smokeResult) && smokeResult.status === 'failed' && !testPassed,
	};
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
			// Lazy (phase 149): openshell-worker only loads in worker mode.
			const { runOpenShellWorker } = await import('./openshell-worker.mjs');
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
	const activeExecutor = await createActiveExecutor(io.cwd, runDir, options);
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

		// Phase 146: probe LM Studio /api/v0/models/{model} for the actual loaded
		// context window. Overrides the static profile value when the server reports
		// a different window and the user has not set --context-window explicitly.
		// Phase 147: a successful probe is labelled 'lmstudio-api' even when the
		// value equals the default, so a confirmed window is distinguishable from a
		// probe-failure fallback (the probe runs for ALL models, matched or not).
		if (!options._contextWindowSet) {
			const probedWindow = await probeLMStudioContextWindow(
				options.baseUrl,
				options.model,
			);
			const resolved = resolveProbedContextWindow(
				probedWindow,
				options.contextWindow,
			);
			if (resolved.source) {
				options.contextWindowSource = resolved.source;
			}
			if (resolved.changed) {
				options.contextWindow = resolved.window;
				options.contextBudgetChars = contextBudgetCharsForWindow(
					resolved.window,
					options.completionReserve,
				);
				if (!options._sessionContextSet) {
					options.sessionContextChars = sessionContextCharsForProfile({
						contextWindow: resolved.window,
						completionReserve: options.completionReserve,
					});
				}
			}
		}

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
				...workspaceContextOptions(options, io.cwd),
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
				...workspaceContextOptions(options, io.cwd),
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
					// T3: envelope mode omits capture tools (write_file/edit_file).
					toolWritesMode: options.toolWritesMode || 'auto',
					// L1/L2: applyMode controls whether capture tools write to disk immediately.
					applyMode: options.applyMode || 'proposal',
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
				// Lazy (phase 149): orchestration (subagents) only loads with
				// --subagent-stages.
				const { runSubagentStages } = await import('./orchestration.mjs');
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
				// Phase 157: the deterministic gates (phase-121 syntax, phase-156 smoke)
				// live in the default path only; orchestration verification runs the test
				// command at most. Run them here too so subagent-stages runs get the same
				// load-time safety. Syntax runs before heal and feeds it on failure
				// (parity with the default path); smoke runs after heal on the final tree.
				const subagentVerifyCwd = await verificationCwd(io.cwd, options);
				const subagentWriteResult = orchestrationResult.writeResult;
				const gatesEligible =
					subagentWriteResult.applied &&
					!orchestrationResult.writeError &&
					!orchestrationResult.runError;
				const syntaxResult = gatesEligible
					? await runSyntaxGateIfNeeded(subagentVerifyCwd, subagentWriteResult)
					: null;
				if (
					syntaxResult &&
					!syntaxResult.ok &&
					!(testResult && testResult.ok)
				) {
					testResult = syntaxResultToVerification(syntaxResult);
				}
				const postWriteDiagnostics = await runPostWriteDiagnostics(
					io.cwd,
					subagentWriteResult,
					options,
				);
				const healingResult = await runHealingIfNeeded({
					cwd: subagentVerifyCwd,
					commandRunner,
					model,
					options,
					postWriteDiagnostics,
					registry,
					runDir,
					systemPrompt: context.systemPrompt,
					testResult,
					writeCount: subagentWriteResult.writes.length,
				});
				if (healingResult?.finalVerification) {
					testResult = healingResult.finalVerification;
					await writeJson(join(runDir, 'tests.json'), testResult);
				}
				const smokeResult =
					gatesEligible && !(syntaxResult && !syntaxResult.ok)
						? await runSmokeCheckIfNeeded(
								subagentVerifyCwd,
								subagentWriteResult,
								{
									enabled: options.smoke !== false,
									sandboxActive: activeExecutor != null,
								},
							)
						: null;
				const { syntaxFailed, smokeFailed } = deterministicGateOutcome({
					syntaxResult,
					smokeResult,
					testResult,
				});
				const runOk =
					!orchestrationResult.writeError &&
					!orchestrationResult.runError &&
					(!testResult || testResult.ok) &&
					!syntaxFailed &&
					!smokeFailed &&
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
					contextWindowSource: options.contextWindowSource || 'profile',
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
				if (healingResult?.goalSubstitutionSuspected) {
					summary.goalSubstitutionSuspected = true;
				}
				// Phase 157: surface the deterministic gates in subagent-stages summaries
				// too (omitted when not run — no JS written, sandbox active, --no-smoke).
				if (syntaxResult !== null) {
					summary.syntaxCheck = syntaxResult;
				}
				if (smokeResult !== null) {
					summary.smokeCheck = smokeResult;
				}
				// Phase 189: gate-skip reasons in subagent-stages summaries.
				{
					const skips = {};
					if (!gatesEligible) {
						const reason = !subagentWriteResult.applied
							? 'write-not-applied'
							: orchestrationResult.writeError
								? 'write-error'
								: 'run-error';
						skips.syntax = { ran: false, reason };
						skips.smoke = { ran: false, reason };
					} else if (options.smoke === false) {
						skips.smoke = { ran: false, reason: 'disabled' };
					} else if (activeExecutor != null && smokeResult === null) {
						skips.smoke = { ran: false, reason: 'sandbox-active' };
					}
					if (options.sensors === false) {
						skips.sensors = { ran: false, reason: 'disabled' };
					}
					if (Object.keys(skips).length > 0) {
						summary.gateSkips = skips;
					}
				}
				// Phase 159: cross-reference sensors (advisory only — no runOk impact).
				const sensorsResult = gatesEligible
					? await runCrossRefSensors(subagentVerifyCwd, subagentWriteResult, {
							enabled: options.sensors !== false,
							sensorToggles: options.sensorToggles,
						})
					: [];
				if (sensorsResult.length > 0) {
					summary.sensors = sensorsResult;
				}
				// Phase 192: proposal sensors when not applied.
				if (
					!subagentWriteResult?.applied &&
					orchestrationResult.proposal?.files?.length > 0
				) {
					const proposalSensorsResult = await runCrossRefSensorsOnProposal(
						orchestrationResult.proposal.files,
						{
							enabled: options.sensors !== false,
							sensorToggles: options.sensorToggles,
						},
					);
					if (proposalSensorsResult.length > 0) {
						summary.proposalSensors = proposalSensorsResult;
					}
				}
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
			contextWindowSource: options.contextWindowSource || 'profile',
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
			// T3: resolved channel mode (native|envelope|auto) for forensics correlation.
			toolWritesMode: options.toolWritesMode || 'auto',
			usage: usageFromBudget(completion.loopBudget),
			workspaceFileCount: contextFileCount(context),
			// D4 (phase 119): system-prompt length for prompt-budget measurement.
			systemPromptChars: (context.systemPrompt || '').length,
		};
		if (completion.transport) {
			summary.transport = completion.transport;
		}
		// L4: record resolved applyMode for forensics.
		summary.applyMode = options.applyMode || 'proposal';
		// Phase 141: record when model was auto-selected from run history.
		if (options.routeAutoModel) {
			summary.routeAuto = options.routeAutoModel;
		}
		if (inspectionPlan) {
			summary.inspectionPlan = inspectionPlan.inspection;
		}
		// W3/W4/D2/D3: integrate capture draft from the tool loop.
		// completion.proposalDraft is the ProposalDraft from the registry (may be null
		// if tools were not enabled, or if no write_file/edit_file calls were made).
		const capturedDraft = completion.proposalDraft ?? null;
		const draftNonEmpty = capturedDraft !== null && !capturedDraft.isEmpty;

		const resolvedToolWritesMode = options.toolWritesMode || 'auto';
		const isNativeMode = resolvedToolWritesMode === 'native';

		// D5: recoveredVia tracks how a native-mode run recovered (if at all).
		// 'none' means no recovery was needed (draft was non-empty or not native mode).
		let recoveredVia = 'none';
		// Forensics fidelity: when D3 recovers via envelope-reprompt, the proposal
		// comes from a SECOND model response. Capture it so response.md/responseChars
		// reflect what actually produced the proposal, and note any envelope-shaped
		// JSON the extractor rejected on the first pass (a near-miss is worth seeing).
		let repromptText = null;
		let recoveryNote = null;

		let proposal = null;
		let proposalError = null;

		if (isNativeMode && draftNonEmpty) {
			// D2: native mode, draft non-empty — the draft IS the proposal.
			// Do NOT attempt JSON parse on the trailing plain-text assistant message.
			// Status comes from verification (the 117 rule). No ProposalMissingError.
			proposal = mergeProposalWithDraft(capturedDraft, null);
			// D2: use the trailing plain-text response as the run message when present.
			// This replaces the synthetic "N files captured via write tools" message.
			const trailingText = completion.text?.trim();
			if (trailingText) {
				proposal = {
					...proposal,
					messages: [{ level: 'info', content: trailingText }],
				};
			}
			proposalError = null;
		} else if (isNativeMode && !draftNonEmpty) {
			// D3: native mode, empty draft — safety net in order:
			//   1. Envelope fallback: parse existing completion.text with extractor.
			//   2. Single re-prompt re-introducing the envelope contract.
			//   3. NativeNoProposalError — never a silent empty proposal.
			let envelopeProposal = null;
			try {
				envelopeProposal = extractProposal(completion.text);
			} catch (error) {
				// Envelope-shaped JSON that failed validation/extraction — a near-miss
				// is more diagnostic than pure prose. Record it before falling through.
				envelopeProposal = null;
				recoveryNote = `envelope-fallback rejected: ${error.message}`;
			}

			if (envelopeProposal !== null) {
				// D3 branch 1: model emitted envelope-shaped JSON anyway (e.g. qwen).
				proposal = envelopeProposal;
				recoveredVia = 'envelope-fallback';
			} else {
				// D3 branch 2: issue EXACTLY ONE re-prompt re-introducing the envelope
				// contract. Never a loop — mirrors the 113 single-retry discipline.
				const envelopeReprompt =
					'You did not use the write_file or edit_file tools. Return your changes as this JSON envelope:\n' +
					renderEditFormatContract('patch');
				let repromptCompletion = null;
				try {
					repromptCompletion = await completeWithContinuations(
						runOptions,
						model,
						'',
						context.systemPrompt,
						{
							initialMessages: [
								...completion.messages,
								{ role: 'user', content: envelopeReprompt },
							],
						},
					);
				} catch {
					// Re-prompt model call failed — fall through to NativeNoProposalError.
				}

				if (repromptCompletion) {
					let repromptProposal = null;
					try {
						repromptProposal = extractProposal(repromptCompletion.text);
					} catch (error) {
						repromptProposal = null;
						recoveryNote = `envelope-reprompt rejected: ${error.message}`;
					}
					if (repromptProposal !== null) {
						proposal = repromptProposal;
						recoveredVia = 'envelope-reprompt';
						repromptText = repromptCompletion.text;
						// The proposal came from this SECOND response. Append it to
						// completion.text (with a marker) so response.md and responseChars
						// reflect what actually produced the proposal instead of the
						// prose-only first turn; record the reprompt size separately.
						completion.text = `${completion.text}\n\n--- envelope re-prompt response ---\n${repromptText}`;
						summary.responseChars = completion.text.length;
						summary.repromptResponseChars = repromptText.length;
						// Merge reprompt responses into completion for artifact accuracy.
						completion.responses.push(...repromptCompletion.responses);
						completion.finishReasons.push(...repromptCompletion.finishReasons);
					}
				}

				if (proposal === null) {
					// D3 branch 3: distinct error — never a silent empty proposal.
					throw new NativeNoProposalError(
						'native-mode model produced no tool writes and no envelope after one re-prompt',
					);
				}
			}
		} else {
			// Envelope mode or auto mode: existing behavior (W3/W4).
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
		}

		// Under-delivery guard: when the prompt explicitly names files the model
		// did not deliver, issue ONE continuation nudge so the missing files can be
		// retrieved in the same run rather than failing at test time.
		// Only fires when: proposal exists, status OK, model used finish_reason:stop,
		// and at least one explicitly-named path is absent from the proposal.
		// A single nudge is issued at most once to avoid loops.
		if (
			proposal?.status === 'OK' &&
			completion.finishReasons?.at(-1) === 'stop' &&
			options.deliveryNudge !== false
		) {
			const deliveredPaths = new Set([
				...(proposal.files ?? []).map((f) => f.path),
				...(proposal.patches ?? []).map((p) => p.path),
			]);
			const promptPaths = extractPromptFilePaths(prompt);
			const missingPaths = promptPaths.filter((p) => !deliveredPaths.has(p));
			if (missingPaths.length > 0) {
				const nudge =
					`Your response is missing ${missingPaths.length} file(s) mentioned in the task: ` +
					missingPaths.map((p) => `\`${p}\``).join(', ') +
					'. Please provide the complete content for each missing file now.';
				let nudgeCompletion = null;
				try {
					nudgeCompletion = await completeWithContinuations(
						runOptions,
						model,
						'',
						context.systemPrompt,
						{
							initialMessages: [
								...completion.messages,
								{ role: 'user', content: nudge },
							],
						},
					);
				} catch {
					// nudge failed — continue with partial proposal
				}
				if (nudgeCompletion) {
					const nudgeDraft = nudgeCompletion.proposalDraft ?? null;
					const nudgeDraftNonEmpty = nudgeDraft && !nudgeDraft.isEmpty;
					let nudgeProposal = null;
					if (nudgeDraftNonEmpty) {
						nudgeProposal = mergeProposalWithDraft(nudgeDraft, null);
					} else {
						try {
							nudgeProposal = extractProposal(nudgeCompletion.text);
						} catch {
							nudgeProposal = null;
						}
					}
					if (nudgeProposal) {
						// Merge: nudge files fill in what was missing; don't overwrite what
						// the original proposal already delivered.
						const existingPaths = new Set(deliveredPaths);
						const newFiles = (nudgeProposal.files ?? []).filter(
							(f) => !existingPaths.has(f.path),
						);
						const newPatches = (nudgeProposal.patches ?? []).filter(
							(p) => !existingPaths.has(p.path),
						);
						proposal = {
							...proposal,
							files: [...(proposal.files ?? []), ...newFiles],
							patches: [...(proposal.patches ?? []), ...newPatches],
						};
						// Extend completion for artifact accuracy.
						completion.messages.push(...nudgeCompletion.messages.slice(-2));
						completion.responses.push(...nudgeCompletion.responses);
						completion.finishReasons.push(...nudgeCompletion.finishReasons);
						summary.deliveryNudge = {
							prompted: missingPaths,
							recovered: [...newFiles, ...newPatches].map((e) => e.path),
						};
					}
				}
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
			const extractionMeta = extractionSummary(proposal);
			if (extractionMeta) {
				summary.extraction = extractionMeta;
			}
			if (isNativeMode) {
				summary.recoveredVia = recoveredVia;
				if (recoveryNote) {
					summary.recoveryNote = recoveryNote;
				}
			}
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

		// L2: in live mode the user opted in to immediate disk writes — all
		// write_file/edit_file calls were applied during the tool loop (backed up via
		// prepareWrites/preparePatches). Skip the interactive gate; treat the run as
		// already applied. 'live' is a distinct applyDecision for forensics.
		const isLiveMode = (options.applyMode || 'proposal') === 'live';

		// Resolve how writes will be decided: 'flag' (--yes), 'live', 'prompt-accepted',
		// 'prompt-declined', or 'none' (no approver / explicit --dry-run).
		let applyDecision = isLiveMode ? 'live' : options.yes ? 'flag' : 'none';
		let shouldApply = isLiveMode || options.yes;
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
				// L2 no-double-write: filter out entries already applied live so the
				// end-of-run prepareChanges does not write them again. The proposal is
				// still assembled from the full draft for summary/diff purposes.
				// Entries with applied:true were written during the tool loop with their
				// own backup; re-running prepareChanges would create duplicate backups
				// and potentially overwrite content the model may have since changed.
				const pendingProposal = {
					...proposal,
					files: (proposal.files || []).filter((f) => !f.applied),
					patches: (proposal.patches || []).filter((p) => !p.applied),
				};

				if (isLiveMode) {
					// Live mode: the user opted in — interactive gate is skipped.
					// Apply only the unapplied entries (typically none in pure live mode,
					// but envelope-mode files or envelope-priority overwrites can exist).
					writeResult = await prepareChanges(io.cwd, pendingProposal, {
						apply: true,
						protectExisting: options.protectExisting,
						protectedPaths: protectedWritePaths(options),
					});
					// Merge the already-applied writes back into writeResult so the run
					// summary correctly reflects all writes (not just the unapplied ones).
					const liveWrites = buildLiveWriteRecords(capturedDraft);
					writeResult = {
						...writeResult,
						applied: true,
						writes: [...liveWrites, ...writeResult.writes],
					};
				} else {
					const hasApprover =
						typeof options.applyApprover === 'function' && !options._dryRunSet;
					if (!options.yes && hasApprover) {
						// Dry-run first to get the real write list, then ask.
						const dryResult = await prepareChanges(io.cwd, pendingProposal, {
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
								writeResult = await prepareChanges(io.cwd, pendingProposal, {
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
						writeResult = await prepareChanges(io.cwd, pendingProposal, {
							apply: options.yes,
							protectExisting: options.protectExisting,
							protectedPaths: protectedWritePaths(options),
						});
					}
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
		// C1 (phase 121): syntax gate — run node --check on every written JS file
		// BEFORE the test command. A file that does not parse cannot be meaningfully
		// tested; a syntax failure is named and fed to the heal loop directly so the
		// model gets a precise signal, not a confusing downstream ENOENT/SyntaxError.
		const verifyCwd = await verificationCwd(io.cwd, options);
		const syntaxResult =
			shouldApply && !writeError && !runError
				? await runSyntaxGateIfNeeded(verifyCwd, writeResult)
				: null;
		// If syntax fails, synthesise a verification-shaped result for the heal loop.
		// The test command is skipped — there is no point running node --test against
		// a file that node --check rejects.
		let testResult =
			options.testCommand && shouldApply && !writeError && !runError
				? syntaxResult && !syntaxResult.ok
					? syntaxResultToVerification(syntaxResult)
					: await runVerification(verifyCwd, options.testCommand, {
							runner: commandRunner,
							timeoutMs: options.timeoutMs,
						})
				: null;
		const healingResult = await runHealingIfNeeded({
			cwd: verifyCwd,
			commandRunner,
			model,
			options: { ...options, yes: shouldApply },
			postWriteDiagnostics,
			registry,
			runDir,
			systemPrompt: context.systemPrompt,
			testResult,
			writeCount: writeResult.writes.length,
		});
		if (healingResult?.finalVerification) {
			testResult = healingResult.finalVerification;
		}
		// Phase 156: executable smoke-check. Once the syntax gate has passed,
		// load-probe the project's entry point in a child process to catch
		// import-time / missing-export / CJS-ESM crashes that `node --check`
		// (parse-only) cannot see — exactly the class of bug that reported ok=true
		// in the phase-155 stress test. Probes the final applied tree (after any
		// heal). Host-only: skipped when a sandbox executor is active so untrusted
		// model code is never run on the host to escape the sandbox. Inconclusive
		// outcomes (deps not installed, timeout) stay advisory; a definitive load
		// failure flips summary.ok below.
		let smokeResult =
			shouldApply &&
			!writeError &&
			!runError &&
			!(syntaxResult && !syntaxResult.ok)
				? await runSmokeCheckIfNeeded(verifyCwd, writeResult, {
						enabled: options.smoke !== false,
						sandboxActive: activeExecutor != null,
					})
				: null;

		// Phase 184: if smoke fails definitively and a testCommand is available,
		// attempt a second heal pass driven by the smoke failure. The heal loop
		// uses options.testCommand for in-loop verification (so the repair is
		// validated end-to-end, not just by re-smoking). Re-run smoke after heal
		// to get the final load-check status.
		let smokeHealResult = null;
		if (
			smokeResult?.status === 'failed' &&
			options.testCommand &&
			shouldApply &&
			!writeError &&
			!runError
		) {
			smokeHealResult = await runHealingIfNeeded({
				cwd: verifyCwd,
				commandRunner,
				model,
				options: { ...options, yes: shouldApply },
				postWriteDiagnostics,
				registry,
				runDir,
				systemPrompt: context.systemPrompt,
				testResult: smokeResultToVerification(smokeResult),
				writeCount: writeResult.writes.length,
			});
			if (smokeHealResult) {
				smokeResult = await runSmokeCheckIfNeeded(verifyCwd, writeResult, {
					enabled: options.smoke !== false,
					sandboxActive: activeExecutor != null,
				});
			}
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
		summary.healed =
			(healingResult ? healingResult.healed : false) ||
			(smokeHealResult ? smokeHealResult.healed : false);
		summary.healStopReason =
			healingResult?.stopReason || smokeHealResult?.stopReason || '';
		if (
			healingResult?.goalSubstitutionSuspected ||
			smokeHealResult?.goalSubstitutionSuspected
		) {
			summary.goalSubstitutionSuspected = true;
		}
		summary.installed = installResult !== null;
		// C1 (phase 121) + phase 156: a syntax failure or a definitive load failure
		// makes the run not-ok even with no testCommand — a file that does not parse,
		// or an app that throws at import, is not a passing run. Inconclusive smoke
		// outcomes never fail; a passing test command overrides both (see helper).
		const { syntaxFailed, smokeFailed } = deterministicGateOutcome({
			syntaxResult,
			smokeResult,
			testResult,
		});
		summary.ok =
			writeError || runError || syntaxFailed || smokeFailed
				? false
				: testResult
					? testResult.ok
					: true;
		summary.proposalMessageCount = proposalMessages.length;
		summary.proposalFound = proposal !== null;
		summary.proposalStatus = proposal?.status || '';
		summary.proposalChannels = proposalChannels;
		const extractionMeta = extractionSummary(proposal);
		if (extractionMeta) {
			summary.extraction = extractionMeta;
		}
		// D5 (phase 119): recoveredVia surfaces how native mode recovered, if at all.
		if (isNativeMode) {
			summary.recoveredVia = recoveredVia;
			if (recoveryNote) {
				summary.recoveryNote = recoveryNote;
			}
		}
		summary.treeState = treeState;
		if (runError) {
			summary.runError = runError;
		}
		// C3 (phase 121): syntaxCheck omitted when no JS files were written (null).
		if (syntaxResult !== null) {
			summary.syntaxCheck = syntaxResult;
		}
		// Phase 156: smokeCheck omitted when not run (no JS entry, sandbox active,
		// --no-smoke, or nothing applied).
		if (smokeResult !== null) {
			summary.smokeCheck = smokeResult;
		}
		// Phase 189: record gate-skip reasons so "didn't run" is distinguishable
		// from "passed" in summary.json forensics (kodr why, trends).
		{
			const gateSkips = {};
			const gatesEligible = shouldApply && !writeError && !runError;
			if (!gatesEligible) {
				const reason = !shouldApply
					? 'write-not-applied'
					: writeError
						? 'write-error'
						: 'run-error';
				gateSkips.syntax = { ran: false, reason };
				gateSkips.smoke = { ran: false, reason };
			} else if (options.smoke === false) {
				gateSkips.smoke = { ran: false, reason: 'disabled' };
			} else if (activeExecutor != null && smokeResult === null) {
				gateSkips.smoke = { ran: false, reason: 'sandbox-active' };
			}
			if (options.sensors === false) {
				gateSkips.sensors = { ran: false, reason: 'disabled' };
			}
			if (Object.keys(gateSkips).length > 0) {
				summary.gateSkips = gateSkips;
			}
		}
		// Phase 159: cross-reference sensors (advisory only — no runOk impact).
		const sensorsResult =
			shouldApply && !writeError && !runError
				? await runCrossRefSensors(verifyCwd, writeResult, {
						enabled: options.sensors !== false,
						sensorToggles: options.sensorToggles,
					})
				: [];
		if (sensorsResult.length > 0) {
			summary.sensors = sensorsResult;
		}
		// Phase 192: run content-safe sensors on proposals before they land.
		// Only fires when the write was NOT applied (dry-run / proposal-only path).
		// Skips local-import/css-selector/compose-dockerfile to avoid false positives
		// from references to existing disk files not present in the proposal.
		if (!writeResult?.applied && proposal?.files?.length > 0) {
			const proposalSensorsResult = await runCrossRefSensorsOnProposal(
				proposal.files,
				{
					enabled: options.sensors !== false,
					sensorToggles: options.sensorToggles,
				},
			);
			if (proposalSensorsResult.length > 0) {
				summary.proposalSensors = proposalSensorsResult;
			}
		}
		// C4 (phase 122): record which Node/ESM guidance applied (builtin vs a
		// project/user `lang:node` override). Omitted when no block fired.
		if (context?.languageGuidance) {
			summary.languageGuidance = {
				language: context.languageGuidance.language,
				source: context.languageGuidance.source,
			};
		}
		// Phase 143: record model-family guidance when it fired.
		if (context?.modelGuidance) {
			summary.modelGuidance = {
				family: context.modelGuidance.family,
				source: context.modelGuidance.source,
			};
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
	const maxStageWrites = 8;
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

	let safeWriteSteering = null;
	let safeWriteSteered = false;
	for (let stageIndex = 1; stageIndex <= maxExecutionStages; stageIndex += 1) {
		const stageContext = await buildWorkspaceContext(io.cwd, {
			environmentFacts,
			memory,
			skills,
			toolsMode: options.tools,
			...workspaceContextOptions(options, io.cwd),
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
			safeWriteSteering ? `\n## Harness note\n${safeWriteSteering}` : '',
		].join('\n');
		safeWriteSteering = null;

		const completion = await completeWithToolCalls(
			{ ...options, inStagedPipeline: true },
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
			// W3 fallback (mirrors main pipeline): if tool-channel writes captured
			// the stage's files, synthesize the proposal from the draft.
			const capturedDraft = completion.proposalDraft ?? null;
			if (capturedDraft && !capturedDraft.isEmpty) {
				proposal = mergeProposalWithDraft(capturedDraft, null);
			}
		}
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
		const uniquePaths = [...new Set(paths)];
		if (uniquePaths.length > maxStageWrites) {
			writeError = {
				message: `Staged proposal touched ${uniquePaths.length} unique paths; limit is ${maxStageWrites}`,
				name: 'StagedProposalTooLargeError',
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				proposedPaths: uniquePaths,
				responseChars: completion.text.length,
			});
			break;
		}

		if (paths.length === 0) {
			done = stageMessages.some((message) =>
				message.content?.includes('STAGED_DONE'),
			);
			// Phase 224: prior safeWriteSteer + zero-write stage = implicit completion.
			// The model has nothing new to apply; treat as STAGED_DONE without model
			// cooperation. Only triggers when safeWriteSteered is already true (i.e. at
			// least one steer fired earlier in this run).
			if (!done && safeWriteSteered) {
				done = true;
				stageRecords.push({
					done,
					implicitDone: true,
					name: `implement-${stageIndex}`,
					appliedPaths: [],
					proposedPaths: paths,
					responseChars: completion.text.length,
				});
				break;
			}
			stageRecords.push({
				done,
				name: `implement-${stageIndex}`,
				noProgress: !done,
				appliedPaths: [],
				proposedPaths: paths,
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
			if (stageIndex > 1 && error instanceof SafeWriteError) {
				// Phase 224: second consecutive safeWriteSteer means the model will
				// never converge — it keeps re-emitting files[] for already-existing
				// paths. Treat as implicit completion.
				if (safeWriteSteered) {
					done = true;
					stageRecords.push({
						done,
						implicitDone: true,
						name: `implement-${stageIndex}`,
						appliedPaths: [],
						proposedPaths: paths,
						responseChars: completion.text.length,
					});
					break;
				}
				// Find ALL files[] entries that already exist on disk and list them
				// in the next stage's prompt so the model uses edit_file/patches[].
				const conflicts = (
					await Promise.all(
						(proposal.files ?? []).map(async (f) => {
							try {
								await access(join(io.cwd, f.path));
								return f.path;
							} catch {
								return null;
							}
						}),
					)
				).filter(Boolean);
				const listed =
					conflicts.length > 0
						? conflicts.map((p) => `\`${p}\``).join(', ')
						: `\`${error.message}\``;
				safeWriteSteering =
					`These files already exist on disk. Use \`edit_file\` or ` +
					`\`patches[]\` to modify them — \`files[]\` is only for new files: ${listed}.`;
				safeWriteSteered = true;
				stageRecords.push({
					name: `implement-${stageIndex}`,
					safeWriteSteer: true,
					appliedPaths: [],
					proposedPaths: paths,
					responseChars: completion.text.length,
				});
				continue;
			}
			writeError = {
				message: error.message,
				name: error.name,
			};
			stageRecords.push({
				error: writeError,
				name: `implement-${stageIndex}`,
				proposedPaths: paths,
				responseChars: completion.text.length,
			});
			break;
		}

		// Phase 225: branch on applied write count.
		// Zero-applied-write stage: proposal claimed paths but prepareChanges produced
		// no writes (e.g. no-op edit_file patches whose search strings no longer match).
		// This is a no-progress event — increment noProgressTurns and, after N=2
		// consecutive such stages gated on allWrites.length > 0, auto-complete
		// (implicitDone) instead of grinding to StagedIncompleteError.
		if (writeResult.writes.length === 0) {
			if (!done && allWrites.length > 0 && noProgressTurns + 1 >= 2) {
				done = true;
				stageRecords.push({
					done,
					implicitDone: true,
					name: `implement-${stageIndex}`,
					appliedPaths: [],
					proposedPaths: paths,
					writeCount: 0,
					responseChars: completion.text.length,
				});
				break;
			}
			noProgressTurns += 1;
			stageRecords.push({
				name: `implement-${stageIndex}`,
				noProgress: true,
				appliedPaths: [],
				proposedPaths: paths,
				writeCount: 0,
				responseChars: completion.text.length,
			});
			scratchpad = [
				scratchpad,
				`No-progress feedback: implementation stage ${stageIndex} made no file changes. Correct that now by returning 1-${maxStageWrites} files or patches.`,
			]
				.filter(Boolean)
				.join('\n\n');
			continue;
		}

		allWrites.push(...writeResult.writes);
		// Clear applied file paths from the shared draft so read_file in the next
		// stage reads from disk rather than returning stale pending-write labels.
		const appliedPaths = writeResult.writes.map((w) => w.path);
		registry?.proposalDraft?.clearFiles(appliedPaths);
		noProgressTurns = 0;
		// Phase 224: real write clears the steer flag so write→steer→write→steer
		// never false-completes (only consecutive steered/zero stages trigger).
		safeWriteSteered = false;
		stageRecords.push({
			applied: writeResult.applied,
			name: `implement-${stageIndex}`,
			appliedPaths,
			proposedPaths: paths,
			responseChars: completion.text.length,
			writeCount: writeResult.writes.length,
		});

		// Inter-stage npm install: if this stage applied package.json and
		// node_modules does not yet exist, install dependencies before the next
		// stage starts.
		if (
			options.installDependencies &&
			options.yes &&
			hasDependencyMetadataWrites(writeResult.writes)
		) {
			const nodeModulesPath = join(io.cwd, 'node_modules');
			try {
				await access(nodeModulesPath);
				// node_modules already exists — skip
			} catch {
				const interInstall = await runDependencyInstall(
					await verificationCwd(io.cwd, options),
					{
						runner: options.installRunner ?? commandRunner,
						timeoutMs: options.timeoutMs,
					},
				);
				if (!interInstall.ok) {
					writeError = {
						message: `Inter-stage dependency install failed: ${interInstall.command}`,
						name: 'DependencyInstallError',
					};
					stageRecords.push({
						error: writeError,
						interStageInstall: true,
						name: `implement-${stageIndex}-install`,
					});
					break;
				}
				stageRecords.push({
					interStageInstall: true,
					name: `implement-${stageIndex}-install`,
					ok: interInstall.ok,
				});
			}
		}
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
		writeCount: allWrites.length,
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
		contextWindowSource: options.contextWindowSource || 'profile',
		promptPrefix: context.promptPrefix || null,
		finishReasons,
		healed: healingResult ? healingResult.healed : false,
		healStopReason: healingResult?.stopReason || '',
		...(healingResult?.goalSubstitutionSuspected
			? { goalSubstitutionSuspected: true }
			: {}),
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

// Phase 128: compact extraction metadata for summary.json / forensics. Returns
// undefined when no proposal or no metadata (omit the field entirely).
function extractionSummary(proposal) {
	const meta = proposal?._extractionMeta;
	if (!meta) return undefined;
	const out = {
		candidateCount: meta.candidateCount ?? 0,
		proposalCount: meta.proposalCount ?? 0,
		merged: meta.merged === true,
	};
	if (Array.isArray(meta.repairs) && meta.repairs.length > 0) {
		out.repairs = meta.repairs.map((r) => ({
			ruleId: r.ruleId,
			count: r.count,
		}));
	}
	return out;
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
	writeCount = null,
}) {
	if (
		(options.heal !== true && options.heal !== 'auto') ||
		!options.yes ||
		!testResult ||
		testResult.ok
	) {
		return null;
	}

	// C2 (phase 125): anti-goal-substitution guard. When the original run produced
	// nothing AND verification ran no tests, there is no code to repair — the model
	// failed to generate, not to pass. Entering the heal loop here is what let a
	// greenfield run "heal" by inventing an unrelated module with its own passing
	// test (phase-113 logstats). Refuse to heal; report honestly instead.
	if (isNothingGenerated(writeCount, testResult)) {
		return {
			finalVerification: testResult,
			healed: false,
			repairs: [],
			skipped: true,
			stopReason: 'nothing-generated',
		};
	}

	// S2: repair turns follow the profile's structuredOutput mode like every other
	// turn type. For local profiles the measured default is 'none', which means
	// response_format is never attached — same wire behavior as before (phase 110
	// decision), now enforced by the profile rule rather than a special case.
	const repairOptions = {
		...options,
		maxRetries: Math.min(options.maxRetries, 1),
		// Phase 136: inner tool-loop budget per heal turn — ceiling raised 4->8 so
		// multi-step tool repair (read -> edits -> verify -> recover) has room.
		maxTurns: healRepairTurnBudget(options.maxTurns),
	};

	return runSelfHealingLoop(cwd, testResult, {
		apply: true,
		artifactDir: join(runDir, 'repairs'),
		diagnostics: postWriteDiagnostics,
		// C1 (phase 125): anchor every repair turn to the original task.
		originalTask: options.prompt || '',
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
			const raw = {
				finishReasons: completion.finishReasons,
				loopBudget: completion.loopBudget,
				responses: completion.responses,
			};
			// B (phase 135): forward the captured tool-call draft so the heal loop
			// can use it when the model expresses repairs via tool calls (native
			// channel) and leaves the text channel empty. Mirror the main path's
			// draftNonEmpty guard so an empty draft never shadows a valid envelope.
			if (options.tools && registry) {
				const capturedDraft = completion.proposalDraft ?? null;
				const draftNonEmpty = capturedDraft && !capturedDraft.isEmpty;
				if (draftNonEmpty) {
					return {
						proposal: mergeProposalWithDraft(capturedDraft, null),
						raw,
						text: completion.text,
					};
				}
			}
			return { raw, text: completion.text };
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
		conversation: sanitizeSessionTail(
			sanitizeSubagentSessionMessages(conversation),
		),
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

async function createInspectionContext(cwd, options, prompt) {
	if (options.inspectContext === false) {
		return null;
	}
	const auto = options.inspectContext === 'auto';
	try {
		// Lazy (phase 149): the external inspector registry (and lsp-client it
		// pulls in) only loads when context inspection actually runs.
		const { inspectWithRegistry } = await import(
			'./external-inspector-registry.mjs'
		);
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

// Exported for testing.
// Known code/config file extensions for under-delivery guard.
const FILE_EXTENSIONS = new Set([
	'mjs',
	'cjs',
	'js',
	'ts',
	'tsx',
	'jsx',
	'json',
	'jsonl',
	'yaml',
	'yml',
	'md',
	'txt',
	'sh',
	'html',
	'css',
	'toml',
	'env',
	'lock',
]);

// Extract explicit file paths mentioned in a task prompt, e.g. from bullet lists.
// Returns a de-duplicated array of path-like strings found in the text.
// Only matches things that look like workspace-relative paths (no leading /).
export function extractPromptFilePaths(promptText) {
	if (!promptText) return [];
	// Strip fenced code blocks — paths inside examples are not output requirements.
	const stripped = promptText.replace(/`{3}[\s\S]*?`{3}/g, '');
	// Match lowercase-starting tokens with at least one / OR a known code extension.
	// Require first char to be lowercase (excludes Node.js, Date.now);
	// word-boundary lookbehind prevents matching mid-word (e.g. 'ode.js' from 'Node.js').
	const pathRe = /(?<!\w)[a-z][\w./-]*\.[a-z]{1,6}/g;
	const found = new Set();
	for (const m of stripped.matchAll(pathRe)) {
		const p = m[0];
		// Skip node: specifiers, URLs, and version strings.
		if (p.includes(':') || /^\d/.test(p)) continue;
		// Skip URL path components — a preceding '/' means absolute route, not a workspace path.
		if (m.index > 0 && stripped[m.index - 1] === '/') continue;
		const ext = p.split('.').at(-1);
		if (p.includes('/')) {
			// Has a directory separator — unambiguously a path.
			found.add(p);
		} else if (FILE_EXTENSIONS.has(ext)) {
			// Bare name (no /): only accept when it starts a line (manifest entry).
			// Rejects mid-sentence references like "the store.mjs module".
			const lineStart = stripped.lastIndexOf('\n', m.index);
			const beforeOnLine = stripped.slice(lineStart + 1, m.index);
			if (/^[ \t]*(?:-[ \t]*)?$/.test(beforeOnLine)) {
				found.add(p);
			}
		}
	}
	return [...found];
}

// L2: collect write records for entries already applied live during the tool loop.
// These go into writeResult.writes so the run summary + writes.json correctly
// account for all writes (live-applied + any end-of-run residual) and so that
// kodr undo can find the hash and backupPath needed to restore prior state.
// Each entry carries a .writeRecord (from prepareWrites/preparePatches) that was
// stored on the draft entry by the tool handler.
function buildLiveWriteRecords(capturedDraft) {
	if (!capturedDraft) return [];
	const records = [];
	for (const file of capturedDraft.files) {
		if (file.applied) {
			// Use the real write record if available; fall back to a minimal stub.
			records.push(
				file.writeRecord || {
					path: file.path,
					status: 'create-or-modify',
					diff: '',
					backupPath: '',
					hash: '',
					appliedLive: true,
				},
			);
		}
	}
	for (const patch of capturedDraft.patches) {
		if (patch.applied) {
			records.push(
				patch.writeRecord || {
					path: patch.path,
					status: 'patch',
					diff: '',
					backupPath: '',
					hash: '',
					appliedLive: true,
				},
			);
		}
	}
	return records;
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

// Re-exported to app.mjs (which keeps main/handleChannelRequest). runPrompt and
// extractPromptFilePaths are already `export`ed inline above.
export {
	createInspectionContext,
	maybeCommitAppliedWrites,
	renderRunSummary,
	verificationCwd,
};
