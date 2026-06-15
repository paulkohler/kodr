import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { writeJson } from './artifacts.mjs';
import {
	buildWorkspaceContext,
	listContextFiles,
	renderContextMarkdown,
} from './context-packer.mjs';
import { loadMemory } from './memory.mjs';
import { jailedPath, prepareChanges } from './safe-writes.mjs';
import { gitTreeState } from './git-workspace.mjs';
import { undoLastApply } from './undo.mjs';
import { discoverSkills, renderSkillIndex } from './skills.mjs';
import { runVerification } from './verification-runner.mjs';
import { formatProgressEvent } from './progress.mjs';
import { parseManagementInstances } from './model-profiles.mjs';
import {
	renderSessionConversation,
	renderSessionList,
	renderSessionMarkdown,
	renderSkillsListing,
} from './render.mjs';
import { renderShowConfig } from './project-config.mjs';
import { inspectWorkspace } from './repomap/index.mjs';
import { filterInspectionIndex } from './inspection-output.mjs';
import {
	createActiveExecutor,
	executorCommandRunner,
	finalizeExecutor,
	initializeExecutor,
} from './active-executor.mjs';
import { loadSessionConversation, scanSessions } from './run-history.mjs';
import { runTui } from './tui.mjs';
import { VERSION } from './version.mjs';
import { CliError, NativeNoProposalError } from './cli-errors.mjs';
import {
	runEvals,
	runRoute,
	runTrends,
	runWhy,
} from './commands/forensics.mjs';
import { runInspect, runRegistry } from './commands/inspect.mjs';
import { runBench } from './commands/bench.mjs';
import { runCompare } from './commands/compare.mjs';
import { runEval } from './commands/eval.mjs';
import { runInitCommand } from './commands/init.mjs';
import { runProbe } from './commands/probe.mjs';
import { runSkills } from './commands/skills.mjs';
import { runCycleReview, runReplay } from './commands/replay.mjs';
import { runServe, runWatch } from './commands/serve.mjs';
import { runPromptHistory, runSession, runUndo } from './commands/session.mjs';
import { loadOptionalPrompt, workspaceContextOptions } from './cli/options.mjs';
import { parseArgs, usage } from './cli/args.mjs';
import {
	createInspectionContext,
	extractPromptFilePaths,
	maybeCommitAppliedWrites,
	renderRunSummary,
	runPrompt,
	verificationCwd,
} from './run-pipeline.mjs';

export { VERSION };

// CliError / NativeNoProposalError live in ./cli-errors.mjs so command modules
// can import them without importing from app.mjs (circular). Re-exported here
// (imported above) to preserve the public surface (phase 148 split).
export { CliError, NativeNoProposalError };
// parseArgs + usage live in ./cli/args.mjs (phase 148 split); imported above
// and re-exported here to preserve the public surface.
export { parseArgs, usage };
// runPrompt + extractPromptFilePaths live in ./run-pipeline.mjs (phase 148
// Stage D); imported above and re-exported here to preserve the public surface.
export { extractPromptFilePaths, runPrompt };

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

	// Phase 141: resolve model from run-history when --route-auto is set and
	// the model was not explicitly specified by flag, env var, or project config.
	if (options.routeAuto && !options.modelExplicit) {
		try {
			const { computeTrends, loadRunSummaries } = await import('./trends.mjs');
			const { recommendModel } = await import('./routing.mjs');
			const runsDir = join(io.cwd, '.kodr', 'runs');
			const report = computeTrends(await loadRunSummaries(runsDir));
			const rec = recommendModel(report);
			if (rec.recommended) {
				options.model = rec.recommended;
				options.modelExplicit = true;
				options.routeAutoModel = rec.recommended;
			}
		} catch {
			// Trends load failure is non-fatal; proceed with the default model.
		}
	}

	if (options.command === 'skills') {
		return runSkills(options, io);
	}

	if (options.command === 'probe') {
		return runProbe(options, io);
	}

	if (options.command === 'init') {
		return runInitCommand(options, io);
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
				...workspaceContextOptions(options, io.cwd),
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
		let result;
		try {
			result = await handleChannelRequest(
				{ kind: 'run-turn', options: runOptions },
				io,
			);
		} catch (error) {
			if (error instanceof NativeNoProposalError) {
				throw new CliError(error.message);
			}
			throw error;
		}
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
		return runServe(options, io, handleChannelRequest);
	}

	if (options.command === 'inspect') {
		return runInspect(options, io);
	}

	if (options.command === 'registry') {
		return runRegistry(options, io);
	}

	if (options.command === 'replay') {
		return runReplay(options, io);
	}

	if (options.command === 'cycle-review') {
		return runCycleReview(options, io);
	}

	if (options.command === 'eval') {
		return runEval(options, io, runPrompt);
	}

	if (options.command === 'compare') {
		return runCompare(options, io);
	}

	if (options.command === 'prompt-history') {
		return runPromptHistory(options, io);
	}

	if (options.command === 'session') {
		return runSession(options, io, handleChannelRequest);
	}

	if (options.command === 'undo') {
		return runUndo(options, io, handleChannelRequest);
	}

	if (options.command === 'bench') {
		return runBench(options, io, runPrompt);
	}

	if (options.command === 'why') {
		return runWhy(options, io);
	}

	if (options.command === 'trends') {
		return runTrends(options, io);
	}

	if (options.command === 'route') {
		return runRoute(options, io);
	}

	if (options.command === 'evals') {
		return runEvals(options, io);
	}

	if (options.command === 'watch') {
		return runWatch(options, io, handleChannelRequest);
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

// Pure CLI renderers moved to ./render.mjs in phase 148; re-exported here so the
// public import surface (tests, channel handlers) is unchanged.
export {
	renderSessionConversation,
	renderSessionList,
	renderSessionMarkdown,
	renderSkillsListing,
};

// parseManagementInstances lives in ./model-profiles.mjs (it parses the LM
// Studio management API). Imported above and re-exported here so the public
// import surface is unchanged (phase 148 split).
export { parseManagementInstances };
