import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { VERSION } from './version.mjs';
import { hashFile, isWorkspaceCase, scoreWorkspaceCase } from './eval.mjs';
import { runVerification } from './verification-runner.mjs';

export function slugify(s) {
	return s
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '');
}

// Probe whether all required toolchain binaries are available.
// Returns null when all present, or the first missing binary name.
export async function probeToolchain(requires) {
	for (const binary of requires) {
		const available = await checkBinaryAvailable(binary);
		if (!available) return binary;
	}
	return null;
}

function checkBinaryAvailable(command) {
	return new Promise((resolve) => {
		const child = spawn(command, ['--version'], {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		const timer = setTimeout(() => {
			child.kill();
			resolve(true);
		}, 3000);
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve(err.code !== 'ENOENT');
		});
		child.on('close', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

// Copy a fixture directory into a fresh temp workspace, skipping .kodr/.
// Returns { stagedDir, baselineHashes } where baselineHashes is a Map<relativePath, sha256hex>.
export async function stageFixture(fixtureDir) {
	const stagedDir = await mkdtemp(join(tmpdir(), 'kodr-eval-fixture-'));

	await copyDir(fixtureDir, stagedDir, stagedDir);

	const baselineHashes = new Map();
	await collectHashes(stagedDir, stagedDir, baselineHashes);

	return { stagedDir, baselineHashes };
}

async function copyDir(src, dest, destRoot) {
	let entries;
	try {
		entries = await readdir(src, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === '.kodr') continue;
		const srcPath = join(src, entry.name);
		const destPath = join(dest, entry.name);
		if (entry.isDirectory()) {
			await mkdir(destPath, { recursive: true });
			await copyDir(srcPath, destPath, destRoot);
		} else if (entry.isFile()) {
			await mkdir(dirname(destPath), { recursive: true });
			await cp(srcPath, destPath);
		}
	}
}

async function collectHashes(rootDir, dir, hashes) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === '.kodr') continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectHashes(rootDir, fullPath, hashes);
		} else if (entry.isFile()) {
			const rel = relative(rootDir, fullPath);
			const hash = await hashFile(fullPath);
			if (hash !== null) hashes.set(rel, hash);
		}
	}
}

// Compare two directories for byte-identical content (mutation guard).
export async function directoriesIdentical(dirA, dirB) {
	const hashesA = new Map();
	const hashesB = new Map();
	await collectHashes(dirA, dirA, hashesA);
	await collectHashes(dirB, dirB, hashesB);

	if (hashesA.size !== hashesB.size) return false;
	for (const [path, hash] of hashesA) {
		if (hashesB.get(path) !== hash) return false;
	}
	return true;
}

// Run the baseline verification in the staged dir. Returns true if it FAILS (as expected).
export async function checkBaselineFails(stagedDir, testCommand, timeoutMs) {
	const result = await runVerification(stagedDir, testCommand, { timeoutMs });
	return !result.ok;
}

// Run a single workspace eval case. Returns a case result object.
export async function runWorkspaceCase(
	evalCase,
	fixtureBaseDir,
	options,
	io,
	evalRunDir,
) {
	const startedAt = new Date().toISOString();
	const started = performance.now();
	const caseRunDir = join(evalRunDir, 'cases', evalCase.id);
	await mkdir(caseRunDir, { recursive: true });

	// Toolchain probing
	if (evalCase.requires && evalCase.requires.length > 0) {
		const missing = await probeToolchain(evalCase.requires);
		if (missing) {
			const reason = `required toolchain not found: ${missing}`;
			return {
				id: evalCase.id,
				status: 'skipped',
				reason,
				durationMs: Math.round(performance.now() - started),
				startedAt,
			};
		}
	}

	const fixtureDir = isAbsolute(evalCase.fixture)
		? evalCase.fixture
		: resolve(fixtureBaseDir, evalCase.fixture);

	// Stage fixture
	const { stagedDir, baselineHashes } = await stageFixture(fixtureDir);

	try {
		// Baseline guard
		if (evalCase.expectFailingBaseline) {
			const baselineFails = await checkBaselineFails(
				stagedDir,
				evalCase.test,
				options.timeoutMs,
			);
			if (!baselineFails) {
				return {
					id: evalCase.id,
					status: 'fixture-invalid',
					reason: `baseline test unexpectedly passed in ${evalCase.id} — fixture may be drifted`,
					durationMs: Math.round(performance.now() - started),
					startedAt,
				};
			}
		}

		// Build options for this case
		const heal = evalCase.heal === 'inherit' ? options.heal : evalCase.heal;
		const caseOptions = {
			...options,
			prompt: evalCase.prompt,
			promptFile: '',
			out: caseRunDir,
			yes: true,
			dryRun: false,
			// Eval runs have no TTY; disable streaming (matches main()'s 'auto' resolution).
			stream: options.stream === 'auto' ? false : options.stream,
			testCommand: evalCase.test,
			heal,
			continueSession: false,
			sessionId: '',
			dockerSandbox: false,
			openshellSandbox: false,
			openshellWorker: false,
			subagentStages: false,
			gitCommit: false,
			enableHooks: false,
			model: evalCase.model || options.model,
			// Suppress interactive prompts
			applyApprover: undefined,
		};

		// Run the full pipeline in the staged workspace.
		// runPrompt is injected to avoid a circular import (app.mjs → eval-runner.mjs → app.mjs).
		const caseIo = {
			cwd: stagedDir,
			env: io.env,
			stderr: { write: () => {} },
			stdin: null,
		};

		let runResult = null;
		let runError = null;
		try {
			runResult = await options._runPrompt(caseOptions, caseIo);
		} catch (error) {
			runError = { message: error.message, name: error.name };
		}

		// Score workspace assertions against the (potentially modified) staged workspace
		const scored = await scoreWorkspaceCase(
			evalCase,
			stagedDir,
			baselineHashes,
			options.timeoutMs,
		);

		const result = {
			...scored,
			status: 'ran',
			durationMs: Math.round(performance.now() - started),
			startedAt,
			model: caseOptions.model,
			caseRunDir,
			applied: runResult?.applied ?? false,
			proposalFound: runResult?.proposalFound ?? false,
			finishReasons: runResult?.finishReasons ?? [],
			repairCount: runResult?.healingResult?.repairCount ?? 0,
		};
		if (runError) result.runError = runError;

		return result;
	} finally {
		await rm(stagedDir, { recursive: true, force: true });
	}
}

// Run all cases in the suite. Returns { suiteResult, caseResults }.
export async function runWorkspaceSuite(
	suite,
	fixtureBaseDir,
	options,
	io,
	evalRunDir,
	filterIds,
) {
	const caseResults = [];

	for (const evalCase of suite.cases) {
		if (!isWorkspaceCase(evalCase)) continue;
		if (filterIds && filterIds.size > 0 && !filterIds.has(evalCase.id))
			continue;

		const result = await runWorkspaceCase(
			evalCase,
			fixtureBaseDir,
			options,
			io,
			evalRunDir,
		);
		caseResults.push(result);
	}

	return caseResults;
}

// Append one JSONL line to evals/results/<suite-slug>/<model-slug>.jsonl.
export async function recordResults(
	kodrCwd,
	suiteName,
	modelId,
	caseResults,
	promptIds,
) {
	const suiteSlug = slugify(suiteName);
	const modelSlug = slugify(modelId);
	const resultsDir = join(kodrCwd, 'evals', 'results', suiteSlug);
	await mkdir(resultsDir, { recursive: true });

	const ranCases = caseResults.filter((r) => r.status === 'ran');
	const passCount = ranCases.filter((r) => r.ok).length;
	const totalCount = ranCases.length;
	const score = totalCount > 0 ? passCount / totalCount : 1;

	const line = {
		timestamp: new Date().toISOString(),
		kodrVersion: VERSION,
		model: modelId,
		suiteName,
		score,
		passCount,
		totalCount,
		cases: caseResults.map((r) => ({
			id: r.id,
			status: r.status,
			ok: r.ok ?? null,
			score: r.score ?? null,
			reason: r.reason ?? undefined,
			durationMs: r.durationMs,
			promptId: promptIds?.get(r.id) ?? undefined,
		})),
	};

	const filePath = join(resultsDir, `${modelSlug}.jsonl`);
	await writeFile(filePath, `${JSON.stringify(line)}\n`, {
		flag: 'a',
		encoding: 'utf8',
	});
	return filePath;
}
