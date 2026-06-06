import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson, writeText } from './artifacts.mjs';
import { extractProposal } from './json-extractor.mjs';
import {
	OpenShellExecutor,
	OpenShellSandboxError,
} from './openshell-executor.mjs';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const KODR_SANDBOX_DIR = '/kodr';
const WORKER_OUT = '.kodr/worker-run';
const WORKER_DOWNLOAD_DIR = 'worker-run';
const KODR_RUNTIME_ENTRIES = ['bin', 'src', 'package.json', 'roadmap.md'];

export async function runOpenShellWorker(
	cwd,
	runDir,
	prompt,
	options,
	io = {},
) {
	const executor = new OpenShellExecutor(cwd, runDir, {
		...options,
		openshellSandbox: true,
	});
	const startedAt = new Date().toISOString();
	const workerArtifact = {
		command: [],
		downloadedArtifacts: '',
		exitCode: null,
		finishedAt: '',
		mode: 'openshell-worker',
		runDir,
		startedAt,
		timedOut: false,
	};

	try {
		await executor.initialize(options.timeoutMs);
		await uploadKodrRuntime(executor, runDir, options.timeoutMs);
		const command = buildWorkerCommand(options);
		workerArtifact.command = redactWorkerCommand(command);
		const result = await executor.run(
			cwd,
			{
				args: command.slice(1),
				bin: command[0],
			},
			options.timeoutMs,
		);
		workerArtifact.exitCode = result.exitCode;
		workerArtifact.timedOut = result.timedOut;
		workerArtifact.stdout = result.stdout;
		workerArtifact.stderr = result.stderr;
		workerArtifact.finishedAt = new Date().toISOString();

		const downloaded = await downloadWorkerArtifacts(
			executor,
			runDir,
			options.timeoutMs,
		);
		workerArtifact.downloadedArtifacts = downloaded.relativePath;
		await writeJson(join(runDir, 'openshell-worker.json'), workerArtifact);
		await writeJson(join(runDir, 'openshell.json'), executor.metadata());

		const summary = await readOptionalJson(
			join(downloaded.path, 'summary.json'),
		);
		const response = await readOptionalText(
			join(downloaded.path, 'response.md'),
		);
		const { proposal, proposalError } = extractOptionalProposal(response);
		const writes = await readOptionalJson(join(downloaded.path, 'writes.json'));
		const tests = await readOptionalJson(join(downloaded.path, 'tests.json'));
		const install = await readOptionalJson(
			join(downloaded.path, 'install.json'),
		);

		const ok =
			result.exitCode === 0 && !result.timedOut && (summary?.ok ?? true);
		const hostSummary = {
			...(summary || {}),
			artifacts: {
				...(summary?.artifacts || {}),
				openshell: 'openshell.json',
				openshellWorker: 'openshell-worker.json',
				workerRun: downloaded.relativePath,
			},
			model: summary?.model || options.model,
			ok,
			openshellWorker: {
				downloadedArtifacts: downloaded.relativePath,
				exitCode: result.exitCode,
				mode: 'openshell-worker',
				timedOut: result.timedOut,
			},
			runDir,
			sessionId: summary?.sessionId || '',
			timestamp: new Date().toISOString(),
		};
		await writeJson(join(runDir, 'summary.json'), hostSummary);
		await writeText(
			join(runDir, 'response.md'),
			response || result.stdout || '',
		);
		await writeJson(join(runDir, 'tests.json'), tests || null);
		await writeJson(join(runDir, 'install.json'), install || null);
		await writeJson(join(runDir, 'writes.json'), writes || null);

		return {
			...hostSummary,
			applied: summary?.applied ?? options.yes,
			applyRequested: options.yes,
			installResult: install,
			loopBudget: summary?.loopBudget || { stopReason: 'openshell_worker' },
			proposal,
			proposalError,
			proposalFound: Boolean(proposal),
			proposalStatus: proposal?.status || summary?.proposalStatus || '',
			response: response || result.stdout || '',
			responsePath: join(runDir, 'response.md'),
			runDir,
			testResult: tests,
			usage: summary?.usage || null,
			writeCount: summary?.writeCount || writes?.writes?.length || 0,
			writeResult: writes || { applied: options.yes, writes: [] },
		};
	} catch (error) {
		workerArtifact.error = serializeError(error);
		workerArtifact.finishedAt = new Date().toISOString();
		await writeJson(join(runDir, 'openshell-worker.json'), workerArtifact);
		await writeJson(join(runDir, 'openshell.json'), executor.metadata());
		const summary = {
			artifacts: {
				openshell: 'openshell.json',
				openshellWorker: 'openshell-worker.json',
				summary: 'summary.json',
			},
			error: workerArtifact.error,
			model: options.model,
			ok: false,
			openshellWorker: {
				mode: 'openshell-worker',
			},
			runDir,
			timestamp: new Date().toISOString(),
		};
		await writeJson(join(runDir, 'summary.json'), summary);
		throw new OpenShellSandboxError(
			`OpenShell worker failed: ${error.message}`,
			workerArtifact.error,
		);
	} finally {
		await executor.finalize(options.timeoutMs);
		await writeJson(join(runDir, 'openshell.json'), executor.metadata());
	}
}

async function uploadKodrRuntime(executor, runDir, timeoutMs) {
	const snapshot = join(runDir, 'openshell-kodr-runtime');
	await rm(snapshot, { force: true, recursive: true });
	await mkdir(snapshot, { recursive: true });
	for (const entry of KODR_RUNTIME_ENTRIES) {
		await cp(join(ROOT, entry), join(snapshot, entry), {
			dereference: false,
			preserveTimestamps: true,
			recursive: true,
			verbatimSymlinks: true,
		});
	}
	await executor.runInternal(['/bin/mkdir', '-p', KODR_SANDBOX_DIR], timeoutMs);
	for (const entry of KODR_RUNTIME_ENTRIES) {
		const result = await executor.runner(
			[
				'sandbox',
				'upload',
				'--no-git-ignore',
				executor.sandboxId,
				join(snapshot, entry),
				`${KODR_SANDBOX_DIR}/${entry}`,
			],
			timeoutMs,
		);
		if (result.exitCode !== 0 || result.timedOut) {
			throw new OpenShellSandboxError('Could not upload Kodr runtime', {
				entry,
				stderr: result.stderr,
				stdout: result.stdout,
			});
		}
	}
}

async function downloadWorkerArtifacts(executor, runDir, timeoutMs) {
	const path = join(runDir, WORKER_DOWNLOAD_DIR);
	await rm(path, { force: true, recursive: true });
	const result = await executor.runner(
		['sandbox', 'download', executor.sandboxId, `/sandbox/${WORKER_OUT}`, path],
		timeoutMs,
	);
	if (result.exitCode !== 0 || result.timedOut) {
		throw new OpenShellSandboxError(
			'Could not download OpenShell worker artifacts',
			{
				stderr: result.stderr,
				stdout: result.stdout,
			},
		);
	}
	return { path, relativePath: relative(runDir, path) };
}

function buildWorkerCommand(options) {
	const args = ['node', `${KODR_SANDBOX_DIR}/bin/kodr.mjs`, 'run'];
	if (options.promptFile) {
		args.push('--prompt-file', options.promptFile);
	} else {
		args.push('-p', options.prompt);
	}
	args.push('--out', WORKER_OUT);
	args.push('--model', options.model);
	args.push('--base-url', options.baseUrl);
	args.push('--timeout-ms', String(options.timeoutMs));
	args.push('--max-turns', String(options.maxTurns));
	args.push('--max-retries', String(options.maxRetries));
	if (options.maxThinkingTokens !== '') {
		args.push('--max-thinking-tokens', String(options.maxThinkingTokens));
	}
	if (options.maxTokens !== '') {
		args.push('--max-tokens', String(options.maxTokens));
	}
	if (options.maxCostUsd !== '') {
		args.push('--max-cost-usd', String(options.maxCostUsd));
	}
	if (options.promptCache) {
		args.push('--prompt-cache', options.promptCache);
	}
	if (options.yes) {
		args.push('--yes');
	}
	if (options.tools) {
		args.push('--tools');
	}
	if (options.installDependencies) {
		args.push('--install');
	}
	if (options.testCommand) {
		args.push('--test', options.testCommand);
	}
	if (options.testCwd) {
		args.push('--test-cwd', options.testCwd);
	}
	if (options.heal) {
		args.push('--heal');
	}
	if (options.subagentStages) {
		args.push('--subagent-stages');
	}
	if (options.skipReview) {
		args.push('--no-review');
	}
	if (options.staged === true) {
		args.push('--staged');
	} else if (options.staged === false) {
		args.push('--no-staged');
	}
	return args;
}

function extractOptionalProposal(response) {
	if (!response) {
		return { proposal: null, proposalError: null };
	}
	try {
		return { proposal: extractProposal(response), proposalError: null };
	} catch (error) {
		return {
			proposal: null,
			proposalError: {
				message: error.message,
				name: error.name,
			},
		};
	}
}

function redactWorkerCommand(command) {
	const redacted = [];
	for (let index = 0; index < command.length; index += 1) {
		redacted.push(command[index]);
		if (command[index] === '--api-key' && index + 1 < command.length) {
			index += 1;
			redacted.push('[redacted]');
		}
	}
	return redacted;
}

async function readOptionalJson(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch {
		return null;
	}
}

async function readOptionalText(path) {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return '';
	}
}

function serializeError(error) {
	return {
		details: error?.details || {},
		message: error?.message || 'Unknown error',
		name: error?.name || 'Error',
	};
}
