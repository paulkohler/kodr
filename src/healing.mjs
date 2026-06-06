import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { writeJson, writeText } from './artifacts.mjs';
import { buildWorkspaceContext } from './context-packer.mjs';
import { extractJson } from './json-extractor.mjs';
import { prepareChanges, prepareWrites } from './safe-writes.mjs';
import { runVerification } from './verification-runner.mjs';

const DEFAULT_REPAIR_TURN_TIMEOUT_MS = 60000;
const SNAPSHOT_EXCLUDE_DIRS = new Set([
	'.git',
	'.kodr',
	'node_modules',
	'dist',
	'build',
	'coverage',
]);

export class HealingTimeoutError extends Error {
	constructor(message) {
		super(message);
		this.name = 'HealingTimeoutError';
	}
}

export async function oneShotHeal(cwd, failedTest, repairText, options = {}) {
	if (failedTest.ok) {
		return {
			healed: false,
			reason: 'Verification already passed.',
		};
	}

	const context = await buildWorkspaceContext(cwd);
	const lastTest = await readLastTest(cwd);
	const repairPrompt = renderRepairPrompt(context.systemPrompt, lastTest);
	const proposal = extractJson(repairText);
	const apply = options.apply === true || options.yes === true;
	const writes = await prepareWrites(cwd, proposal.files, { apply });
	const verification = apply
		? await runVerification(cwd, options.testCommand, {
				runner: options.commandRunner || null,
				timeoutMs: options.timeoutMs || 60000,
			})
		: null;

	return {
		healed: verification ? verification.ok : false,
		repairPrompt,
		verification,
		writes,
	};
}

export async function runSelfHealingLoop(cwd, failedTest, options = {}) {
	if (failedTest.ok) {
		return {
			healed: false,
			reason: 'Verification already passed.',
			repairs: [],
		};
	}
	if (!options.repairTurn) {
		throw new Error('runSelfHealingLoop requires repairTurn');
	}
	if (!options.testCommand) {
		throw new Error('runSelfHealingLoop requires testCommand');
	}

	const apply = options.apply === true || options.yes === true;
	const maxTurns = Math.max(1, options.maxTurns || 2);
	const turnTimeoutMs =
		options.turnTimeoutMs ||
		options.timeoutMs ||
		DEFAULT_REPAIR_TURN_TIMEOUT_MS;
	const artifactDir = options.artifactDir || join(cwd, '.kodr', 'repairs');
	const repairs = [];
	let verification = failedTest;
	let scratchpad = options.scratchpad || '';
	let noProgressCount = 0;
	let stopReason = '';

	await mkdir(artifactDir, { recursive: true });
	await writeJson(join(artifactDir, 'initial-tests.json'), failedTest);

	for (let index = 1; index <= maxTurns; index += 1) {
		const turnDir = join(artifactDir, `turn-${index}`);
		await mkdir(turnDir, { recursive: true });
		const before = await workspaceSnapshot(cwd);
		const repairContext = await buildRepairContext(cwd, verification, {
			scratchpad,
		});
		const prompt = renderLoopRepairPrompt(repairContext, {
			index,
			maxTurns,
		});
		await writeText(join(turnDir, 'prompt.md'), prompt);
		await writeJson(join(turnDir, 'repair-context.json'), repairContext);

		let completion;
		try {
			completion = await withTimeout(
				options.repairTurn({ index, prompt, repairContext, scratchpad }),
				turnTimeoutMs,
				`Repair turn ${index} exceeded ${turnTimeoutMs}ms`,
			);
		} catch (error) {
			const timeout = serializeError(error);
			await writeJson(join(turnDir, 'error.json'), timeout);
			stopReason =
				error instanceof HealingTimeoutError ? 'timeout' : 'repair_error';
			repairs.push({
				error: timeout,
				index,
				ok: false,
				stopReason,
			});
			break;
		}

		await writeText(join(turnDir, 'response.md'), completion.text || '');
		if (completion.raw) {
			await writeJson(join(turnDir, 'raw-response.json'), completion.raw);
		}

		let proposal;
		try {
			proposal = normalizeRepairProposal(extractJson(completion.text || ''));
		} catch (error) {
			const serialized = serializeError(error);
			await writeJson(join(turnDir, 'error.json'), serialized);
			stopReason = 'invalid_proposal';
			repairs.push({
				error: serialized,
				index,
				ok: false,
				stopReason,
			});
			break;
		}

		if (proposal.scratchpad) {
			scratchpad = proposal.scratchpad;
		}

		const writes = await prepareChanges(cwd, proposal, { apply });
		await writeJson(join(turnDir, 'writes.json'), writes);

		const after = await workspaceSnapshot(cwd);
		const snapshotDiff = diffSnapshots(before, after);
		await writeJson(join(turnDir, 'snapshot-diff.json'), snapshotDiff);

		if (snapshotDiff.changed.length === 0) {
			noProgressCount += 1;
			repairs.push({
				index,
				ok: false,
				snapshotDiff,
				stopReason: noProgressCount >= 2 ? 'no_progress' : '',
				writes,
			});
			if (noProgressCount >= 2) {
				stopReason = 'no_progress';
				break;
			}
			continue;
		}

		if (!touchesFailurePath(writes.writes, repairContext.failurePaths)) {
			stopReason = 'wrong_path';
			repairs.push({
				index,
				ok: false,
				snapshotDiff,
				stopReason,
				writes,
			});
			break;
		}

		verification = apply
			? await runVerification(cwd, options.testCommand, {
					runner: options.commandRunner || null,
					timeoutMs: options.timeoutMs || 60000,
				})
			: verification;
		await writeJson(join(turnDir, 'tests.json'), verification);

		repairs.push({
			index,
			ok: verification.ok,
			snapshotDiff,
			tests: verification,
			writes,
		});

		if (verification.ok) {
			stopReason = 'healed';
			break;
		}
		noProgressCount = 0;
	}

	if (!stopReason) {
		stopReason = 'max_turns';
	}

	const result = {
		finalVerification: verification,
		healed: verification.ok,
		repairs,
		stopReason,
	};
	await writeJson(join(artifactDir, 'repairs.json'), result);
	return result;
}

export async function buildRepairContext(cwd, testResult, options = {}) {
	const failurePaths = await failurePathsFromTest(cwd, testResult);
	const contextFiles = new Map();
	for (const path of failurePaths) {
		contextFiles.set(path, await readFileOrEmpty(cwd, path));
		const sourcePath = siblingSourcePath(path);
		if (sourcePath) {
			contextFiles.set(sourcePath, await readFileOrEmpty(cwd, sourcePath));
		}
	}

	return {
		failurePaths,
		files: [...contextFiles.entries()].map(([path, content]) => ({
			content,
			path,
		})),
		scratchpad: options.scratchpad || '',
		tests: testResult,
	};
}

function renderRepairPrompt(systemPrompt, lastTest) {
	return `${systemPrompt}

The previous verification failed. Use this test output and propose exactly one repair JSON object.

${lastTest}`;
}

function renderLoopRepairPrompt(repairContext, { index, maxTurns }) {
	const files = repairContext.files
		.map(
			(file) => `## ${file.path}

\`\`\`
${file.content}
\`\`\``,
		)
		.join('\n\n');
	const tests = JSON.stringify(repairContext.tests, null, 2);
	const scratchpad = repairContext.scratchpad
		? `\n\n## Prior scratchpad\n${repairContext.scratchpad}`
		: '';

	return `Repair turn ${index} of ${maxTurns}.

The previous verification failed. Propose one small repair as JSON with optional files, patches, and scratchpad fields. Prefer patches. Touch the failing path unless the stack trace clearly points elsewhere.

## tests.json
\`\`\`json
${tests}
\`\`\`

${files}${scratchpad}`;
}

async function readLastTest(cwd) {
	try {
		return await readFile(join(cwd, '.kodr', 'last-test.md'), 'utf8');
	} catch {
		return 'No last-test.md was available.';
	}
}

function normalizeRepairProposal(proposal) {
	return {
		files: Array.isArray(proposal.files) ? proposal.files : [],
		patches: Array.isArray(proposal.patches) ? proposal.patches : [],
		scratchpad:
			typeof proposal.scratchpad === 'string' ? proposal.scratchpad : '',
	};
}

async function failurePathsFromTest(cwd, testResult) {
	const text = `${testResult.stdout || ''}\n${testResult.stderr || ''}`;
	const candidates = new Set();
	const escapedCwd = escapeRegExp(cwd.replaceAll('\\', '/'));
	const absolutePattern = new RegExp(`${escapedCwd}/([^\\s:)]+)`, 'gu');
	for (const match of text.replaceAll('\\', '/').matchAll(absolutePattern)) {
		candidates.add(match[1]);
	}

	const relativePattern =
		/\b((?:src|test|tests|lib|bin|migrations)\/[A-Za-z0-9._/-]+\.[cm]?[jt]s)\b/gu;
	for (const match of text.matchAll(relativePattern)) {
		candidates.add(match[1]);
	}

	return normalizeFailurePaths(cwd, candidates);
}

async function normalizeFailurePaths(cwd, candidates) {
	const paths = [
		...new Set(
			[...candidates]
				.map((path) => path.replaceAll('\\', '/').replace(/^\.\//u, ''))
				.filter(
					(path) => path && !path.startsWith('../') && !path.startsWith('/'),
				),
		),
	];
	const existing = new Set();
	for (const path of paths) {
		if (await fileExists(join(cwd, path))) {
			existing.add(path);
		}
	}

	const normalized = paths.filter((path) => {
		if (existing.has(path)) {
			return true;
		}
		return ![...existing].some((existingPath) =>
			path.endsWith(`/${existingPath}`),
		);
	});

	return normalized.sort((left, right) => {
		const existingDelta =
			Number(existing.has(right)) - Number(existing.has(left));
		return existingDelta || left.localeCompare(right);
	});
}

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function siblingSourcePath(path) {
	if (path.endsWith('.test.js')) return path.replace(/\.test\.js$/u, '.js');
	if (path.endsWith('.test.mjs')) return path.replace(/\.test\.mjs$/u, '.mjs');
	if (path.endsWith('-test.js')) return path.replace(/-test\.js$/u, '.js');
	if (path.endsWith('-test.mjs')) return path.replace(/-test\.mjs$/u, '.mjs');
	return '';
}

async function readFileOrEmpty(cwd, path) {
	try {
		return await readFile(join(cwd, path), 'utf8');
	} catch {
		return '';
	}
}

async function workspaceSnapshot(cwd) {
	const files = [];
	await collectSnapshotFiles(cwd, cwd, files);
	files.sort((left, right) => left.path.localeCompare(right.path));
	return files;
}

async function collectSnapshotFiles(cwd, dir, files) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const absolute = join(dir, entry.name);
		const path = relative(cwd, absolute);
		if (entry.isDirectory()) {
			if (
				SNAPSHOT_EXCLUDE_DIRS.has(entry.name) ||
				entry.name.startsWith('.kodr')
			) {
				continue;
			}
			await collectSnapshotFiles(cwd, absolute, files);
		} else if (entry.isFile()) {
			const content = await readFile(absolute);
			files.push({
				hash: createHash('sha256').update(content).digest('hex'),
				path,
				size: content.length,
			});
		}
	}
}

function diffSnapshots(before, after) {
	const beforeMap = new Map(before.map((file) => [file.path, file]));
	const afterMap = new Map(after.map((file) => [file.path, file]));
	const changed = [];

	for (const [path, afterFile] of afterMap) {
		const beforeFile = beforeMap.get(path);
		if (!beforeFile) {
			changed.push({ path, status: 'create' });
		} else if (
			beforeFile.hash !== afterFile.hash ||
			beforeFile.size !== afterFile.size
		) {
			changed.push({ path, status: 'modify' });
		}
	}
	for (const path of beforeMap.keys()) {
		if (!afterMap.has(path)) {
			changed.push({ path, status: 'delete' });
		}
	}

	return {
		changed: changed.sort((left, right) => left.path.localeCompare(right.path)),
	};
}

function touchesFailurePath(writes, failurePaths) {
	if (failurePaths.length === 0) {
		return true;
	}
	const failures = new Set(failurePaths);
	return writes.some((write) => failures.has(write.path));
}

function withTimeout(promise, timeoutMs, message) {
	let timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => {
				reject(new HealingTimeoutError(message));
			}, timeoutMs);
		}),
	]);
}

function serializeError(error) {
	return {
		message: error?.message || 'Unknown error',
		name: error?.name || 'Error',
	};
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
