import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { writeJson, writeText } from './artifacts.mjs';
import { renderDiagnosticsForModel } from './harness.mjs';
import { buildWorkspaceContext } from './context-packer.mjs';
import { extractJson } from './json-extractor.mjs';
import { prepareChanges, prepareWrites } from './safe-writes.mjs';
import { runVerification } from './verification-runner.mjs';

const DEFAULT_REPAIR_TURN_TIMEOUT_MS = 60000;
// D2: cap per-turn default to 4 minutes — a repair turn that needs more than
// this on a local model is not converging.
const MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS = 240_000;
const SNAPSHOT_EXCLUDE_DIRS = new Set([
	'.git',
	'.kodr',
	'node_modules',
	'dist',
	'build',
	'coverage',
]);

// Patterns that indicate a test/verification failure line
const FAIL_LINE_PATTERNS = [
	/\bnot ok\b/u,
	/\bFAIL(?:ED|URE)?\b/u,
	/✗/u,
	/\bfailing\b/u,
	/\b\d+\s+fail(?:ing|ed)?\b/u,
];

export function extractFailCount(testResult) {
	const text = `${testResult?.stdout || ''}\n${testResult?.stderr || ''}`;
	let count = 0;
	for (const line of text.split('\n')) {
		for (const pattern of FAIL_LINE_PATTERNS) {
			if (pattern.test(line)) {
				count += 1;
				break;
			}
		}
	}
	return count;
}

export function computeTestDelta(previousTest, currentTest) {
	const before = extractFailCount(previousTest);
	const after = extractFailCount(currentTest);
	return {
		before,
		after,
		improved: after < before,
	};
}

export function renderEscalationPrompt(repairContext, { index, maxTurns }) {
	const tests = JSON.stringify(repairContext.tests, null, 2);
	const scratchpad = repairContext.scratchpad
		? `\n\n## Prior scratchpad\n${repairContext.scratchpad}`
		: '';
	const taskSection = repairContext.originalTask
		? `\n\n## Original task\nThe repair must serve this original request — do not solve a different or simpler problem:\n${repairContext.originalTask}`
		: '';
	return `Repair turn ${index} of ${maxTurns} — ESCALATION.

Your previous turn proposed no changes. The failing tests are still unresolved. Restate your repair plan and propose concrete patches or file writes.
${taskSection}
## Failing tests (still unresolved)
\`\`\`json
${tests}
\`\`\`
${scratchpad}

Propose one small repair as JSON with optional files, patches, and scratchpad fields. You MUST write to the failing path.`;
}

// C2 (phase 125): true when verification ran zero tests. A node:test / TAP run
// that found no test files reports "tests 0" (and often "no test files found").
// A non-zero exit with zero tests is "nothing to repair", not a failing suite.
export function hasNoTestsRun(testResult) {
	const text = `${testResult?.stdout || ''}\n${testResult?.stderr || ''}`;
	if (/(^|\n)#?\s*tests\s+0\b/u.test(text)) return true;
	if (/no test files found|could not find any test/iu.test(text)) return true;
	return false;
}

// Phase 136: the inner tool-loop budget for a single heal repair turn. The cap
// was 4, sized for one-shot envelope repair (read nothing, emit one proposal).
// Tool-channel repair is multi-step — read -> edit(s) -> re-read/verify ->
// recover from a no_match hunt — and the 135 re-validation showed every outer
// turn hitting `turn_budget_exhausted` at 4. Raise the ceiling to 8 so a
// default `--max-turns 8` run gets real repair room, while leaving the low end
// (maxTurns <= 4) exactly as before and keeping a hard cap so a large
// --max-turns can't make one heal turn run away.
export function healRepairTurnBudget(maxTurns) {
	const requested = Number.isFinite(maxTurns) ? Math.trunc(maxTurns) : 1;
	return Math.min(Math.max(requested, 1), 8);
}

// C2 (phase 125): the anti-goal-substitution condition. The original run wrote
// nothing AND verification ran no tests → the model failed to generate, not to
// pass. Healing here only invents unrelated code with its own passing test
// (phase-113 logstats). Such a run must be reported honestly, never "healed".
export function isNothingGenerated(writeCount, testResult) {
	return writeCount === 0 && hasNoTestsRun(testResult);
}

// Phase 130: does any healing write plausibly serve the original task? True if a
// written path or its basename appears in the task text. Used to distinguish a
// legitimate new-file repair (task names the file) from goal-substitution (the
// heal invents an unrelated file whose own test happens to pass).
export function writesReferenceTask(writes, originalTask) {
	if (!originalTask || writes.length === 0) return false;
	const task = originalTask.toLowerCase();
	return writes.some((w) => {
		const path = w.path.toLowerCase();
		const base = path.split('/').at(-1);
		return task.includes(path) || (base.length > 0 && task.includes(base));
	});
}

export function renderWrongPathWarning(writes, failurePaths) {
	const failureSet = new Set(failurePaths);
	const writtenPaths = writes.map((w) => w.path);
	const wrongPaths = writtenPaths.filter((p) => !failureSet.has(p));
	if (wrongPaths.length === 0) return '';
	const expected = failurePaths.join(', ') || '(unknown)';
	const actual = wrongPaths.join(', ');
	return `Warning: you wrote to [${actual}] but the failure is in [${expected}]. Fix the correct file.`;
}

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
	let diagnostics = options.diagnostics || null;
	const diagnosticsProvider = options.diagnosticsProvider || null;
	// D2: explicit option wins; otherwise cap the per-turn default to 4 min so
	// a hung local model call doesn't silently consume the full run timeout.
	const turnTimeoutMs = options.turnTimeoutMs
		? options.turnTimeoutMs
		: Math.min(
				options.timeoutMs || DEFAULT_REPAIR_TURN_TIMEOUT_MS,
				MAX_DEFAULT_REPAIR_TURN_TIMEOUT_MS,
			);
	const artifactDir = options.artifactDir || join(cwd, '.kodr', 'repairs');
	const repairs = [];
	let verification = failedTest;
	let scratchpad = options.scratchpad || '';
	let noProgressCount = 0;
	let wrongPathCount = 0;
	let wrongPathWarnings = 0;
	let previousVerification = failedTest;
	let stopReason = '';
	// Phase 130: set when the heal passed via writes that touched no known path
	// AND don't reference the original task — a likely goal-substitution.
	let goalSubstitutionSuspected = false;

	await mkdir(artifactDir, { recursive: true });
	await writeJson(join(artifactDir, 'initial-tests.json'), failedTest);

	for (let index = 1; index <= maxTurns; index += 1) {
		const turnDir = join(artifactDir, `turn-${index}`);
		await mkdir(turnDir, { recursive: true });
		const before = await workspaceSnapshot(cwd);
		const repairContext = await buildRepairContext(cwd, verification, {
			scratchpad,
			diagnostics,
			originalTask: options.originalTask || '',
		});

		// Build optional escalation / wrong-path-warning / test-delta extras
		const escalation = noProgressCount === 1;
		const wrongPathWarning =
			wrongPathCount === 1
				? renderWrongPathWarning(
						repairs.at(-1)?.writes?.writes || [],
						repairContext.failurePaths,
					)
				: '';
		const testDelta =
			previousVerification !== failedTest
				? computeTestDelta(previousVerification, verification)
				: null;

		const prompt = escalation
			? renderEscalationPrompt(repairContext, { index, maxTurns })
			: renderLoopRepairPrompt(repairContext, {
					index,
					maxTurns,
					wrongPathWarning,
					testDelta,
				});
		await writeText(join(turnDir, 'prompt.md'), prompt);
		await writeJson(join(turnDir, 'repair-context.json'), repairContext);

		let completion;
		const turnStart = Date.now();
		try {
			completion = await withTimeout(
				options.repairTurn({ index, prompt, repairContext, scratchpad }),
				turnTimeoutMs,
				`Repair turn ${index} exceeded ${turnTimeoutMs}ms`,
			);
		} catch (error) {
			const elapsedMs = Date.now() - turnStart;
			const serialized = serializeError(error);
			const isTimeout = error instanceof HealingTimeoutError;
			// D1: persist elapsed and limit alongside the error for diagnostics
			const errorDetail = {
				...serialized,
				elapsedMs,
				timeoutMs: turnTimeoutMs,
			};
			await writeJson(join(turnDir, 'error.json'), errorDetail);
			// D1: turn-meta.json captures per-turn timing even on failure
			await writeJson(join(turnDir, 'turn-meta.json'), {
				completionChars: 0,
				durationMs: elapsedMs,
				promptChars: prompt.length,
				timeoutMs: turnTimeoutMs,
				usage: null,
			});
			stopReason = isTimeout ? 'timeout' : 'repair_error';
			repairs.push({
				completionChars: 0,
				durationMs: elapsedMs,
				elapsedMs,
				error: errorDetail,
				index,
				ok: false,
				promptChars: prompt.length,
				stopReason,
				timeoutMs: turnTimeoutMs,
				usage: null,
			});
			break;
		}
		const durationMs = Date.now() - turnStart;

		await writeText(join(turnDir, 'response.md'), completion.text || '');
		if (completion.raw) {
			await writeJson(join(turnDir, 'raw-response.json'), completion.raw);
		}
		// D1: capture turn-level timing/sizing for diagnostics
		const completionChars = (completion.text || '').length;
		const promptChars = prompt.length;
		const usage = completion.raw?.loopBudget?.usage ?? null;
		await writeJson(join(turnDir, 'turn-meta.json'), {
			completionChars,
			durationMs,
			promptChars,
			timeoutMs: turnTimeoutMs,
			usage,
		});

		// A (phase 135): channel parity with the main native path.
		// If the repairTurn forwarded a pre-built proposal (tool-call channel),
		// prefer it when it carries at least one file or patch. Otherwise fall
		// back to the text/envelope extractor (unchanged behaviour for models
		// that express repairs as JSON in their text response).
		let proposal;
		const turnProposal = completion.proposal ?? null;
		const turnProposalNonEmpty =
			turnProposal !== null &&
			((Array.isArray(turnProposal.files) && turnProposal.files.length > 0) ||
				(Array.isArray(turnProposal.patches) &&
					turnProposal.patches.length > 0));
		try {
			if (turnProposalNonEmpty) {
				proposal = normalizeRepairProposal(turnProposal);
			} else {
				proposal = normalizeRepairProposal(extractJson(completion.text || ''));
			}
		} catch (error) {
			const serialized = serializeError(error);
			await writeJson(join(turnDir, 'error.json'), serialized);
			stopReason = 'invalid_proposal';
			repairs.push({
				completionChars,
				durationMs,
				error: serialized,
				index,
				ok: false,
				promptChars,
				stopReason,
				timeoutMs: turnTimeoutMs,
				usage,
			});
			break;
		}

		if (proposal.scratchpad) {
			scratchpad = proposal.scratchpad;
		}

		// D3 (revised during D4): no pre-apply path gating. The first heal trial
		// proved heuristic gates that block measurement are wrong — a "wrong
		// path" write can be the correct fix (the failing path is the symptom,
		// not the bug). Writes always apply, verification always runs, and
		// wrong-path is post-verification steering only.
		const writes = await prepareChanges(cwd, proposal, { apply });
		await writeJson(join(turnDir, 'writes.json'), writes);

		const after = await workspaceSnapshot(cwd);
		const snapshotDiff = diffSnapshots(before, after);
		await writeJson(join(turnDir, 'snapshot-diff.json'), snapshotDiff);

		if (snapshotDiff.changed.length === 0) {
			noProgressCount += 1;
			if (noProgressCount >= 2) {
				stopReason = 'no-progress-exhausted';
				repairs.push({
					completionChars,
					durationMs,
					index,
					ok: false,
					promptChars,
					snapshotDiff,
					stopReason,
					timeoutMs: turnTimeoutMs,
					usage,
					writes,
				});
				break;
			}
			// First no-progress turn: escalate (loop continues, next turn uses escalation prompt)
			repairs.push({
				completionChars,
				durationMs,
				index,
				ok: false,
				promptChars,
				snapshotDiff,
				stopReason: '',
				timeoutMs: turnTimeoutMs,
				usage,
				writes,
			});
			continue;
		}

		// Reset no-progress counter when the model makes actual changes
		noProgressCount = 0;

		// Wrong-path is judged against the full repair-context set: failing-test
		// paths plus every file shown to the model (siblings, imported sources).
		// Editing an imported source file is the normal repair shape — the
		// failing path is where the symptom is, not where the bug lives.
		const touchesKnownPath = touchesFailurePath(
			writes.writes,
			allowedRepairPaths(repairContext),
		);
		if (touchesKnownPath) {
			wrongPathCount = 0;
		}

		// Re-run diagnostics on changed files if a provider was given
		if (diagnosticsProvider) {
			const changedPaths = snapshotDiff.changed
				.filter((c) => c.status !== 'delete')
				.map((c) => c.path);
			try {
				diagnostics = await diagnosticsProvider(changedPaths);
				await writeJson(join(turnDir, 'diagnostics.json'), diagnostics);
			} catch {
				// Sensor failure must never abort a repair turn
			}
		}

		previousVerification = verification;
		verification = apply
			? await runVerification(cwd, options.testCommand, {
					runner: options.commandRunner || null,
					timeoutMs: options.timeoutMs || 60000,
				})
			: verification;
		await writeJson(join(turnDir, 'tests.json'), verification);

		const turnTestDelta = computeTestDelta(previousVerification, verification);
		await writeJson(join(turnDir, 'test-delta.json'), turnTestDelta);

		// Verification is ground truth: a wrong-path write that passes tests is
		// healed. Wrong-path bookkeeping only applies to writes that missed the
		// known set AND failed to fix anything.
		if (!verification.ok && !touchesKnownPath) {
			wrongPathCount += 1;
			const wrongPathSiblings = writes.writes.map((w) => ({
				actual: w.path,
				expected: repairContext.failurePaths[0] || '',
			}));
			if (wrongPathCount >= 2) {
				stopReason = 'wrong_path_exhausted';
				repairs.push({
					completionChars,
					durationMs,
					index,
					ok: false,
					promptChars,
					snapshotDiff,
					stopReason,
					testDelta: turnTestDelta,
					tests: verification,
					timeoutMs: turnTimeoutMs,
					usage,
					wrongPathSiblings,
					writes,
				});
				break;
			}
			// First wrong-path turn: warn (next turn's prompt carries the warning)
			wrongPathWarnings += 1;
			repairs.push({
				completionChars,
				durationMs,
				index,
				ok: false,
				promptChars,
				snapshotDiff,
				stopReason: '',
				testDelta: turnTestDelta,
				tests: verification,
				timeoutMs: turnTimeoutMs,
				usage,
				wrongPathSiblings,
				writes,
			});
			continue;
		}

		repairs.push({
			completionChars,
			durationMs,
			index,
			ok: verification.ok,
			promptChars,
			snapshotDiff,
			testDelta: turnTestDelta,
			tests: verification,
			timeoutMs: turnTimeoutMs,
			usage,
			writes,
		});

		if (verification.ok) {
			stopReason = 'healed';
			// Phase 130: relevance judge. The heal passed, but if the writes that
			// made it pass touched no known path (failing test / shown sources) and
			// don't reference the original task, this is a suspected
			// goal-substitution — verification went green on invented, unrelated
			// code. Flagged, not failed: a legitimate new-file repair the task names
			// is exonerated by writesReferenceTask.
			if (
				!touchesKnownPath &&
				!writesReferenceTask(writes.writes, repairContext.originalTask)
			) {
				goalSubstitutionSuspected = true;
			}
			break;
		}
	}

	if (!stopReason) {
		stopReason = 'max_turns';
	}

	const result = {
		finalVerification: verification,
		goalSubstitutionSuspected,
		healed: verification.ok,
		repairs,
		stopReason,
		wrongPathWarnings,
	};
	await writeJson(join(artifactDir, 'repairs.json'), result);
	return result;
}

export async function buildRepairContext(cwd, testResult, options = {}) {
	const failurePaths = await failurePathsFromTest(cwd, testResult);
	const contextFiles = new Map();
	for (const path of failurePaths) {
		// F6: only include files that exist and are readable — never ghost entries.
		const content = await readFileIfExists(cwd, path);
		if (content !== null) {
			contextFiles.set(path, content);
		}
		const sourcePath = siblingSourcePath(path);
		if (sourcePath) {
			const sourceContent = await readFileIfExists(cwd, sourcePath);
			if (sourceContent !== null) {
				contextFiles.set(sourcePath, sourceContent);
			}
		}
	}

	// D6: a failing test usually imports the code under repair. Without those
	// files the no-tools repair model can only ask to "read the source" and the
	// loop dead-ends (observed live in the phase 110 heal trial). Resolve
	// relative import specifiers from the files already in context, bounded so
	// repair prompts stay small.
	await addImportedSourceFiles(cwd, contextFiles);

	return {
		diagnostics: options.diagnostics || null,
		failurePaths,
		files: [...contextFiles.entries()].map(([path, content]) => ({
			content,
			path,
		})),
		// Phase 125: anchor the repair to what was actually asked. Without this the
		// repair prompt carries only "the previous verification failed" + tests +
		// failing files — enough for a model to drift into fixing the wrong thing
		// or (greenfield) inventing an unrelated module with its own passing test.
		originalTask: options.originalTask || '',
		scratchpad: options.scratchpad || '',
		tests: testResult,
	};
}

function renderRepairPrompt(systemPrompt, lastTest) {
	return `${systemPrompt}

The previous verification failed. Use this test output and propose exactly one repair JSON object.

${lastTest}`;
}

function renderLoopRepairPrompt(
	repairContext,
	{ index, maxTurns, wrongPathWarning = '', testDelta = null },
) {
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
	const diagnosticsSection = repairContext.diagnostics
		? `\n\n## Diagnostics on changed files\n\n${renderDiagnosticsForModel(repairContext.diagnostics)}`
		: '';
	const wrongPathSection = wrongPathWarning
		? `\n\n## Path warning\n${wrongPathWarning}`
		: '';
	const taskSection = repairContext.originalTask
		? `\n\n## Original task\nThe repair must serve this original request — do not solve a different or simpler problem:\n${repairContext.originalTask}`
		: '';
	const testDeltaSection =
		testDelta && !testDelta.improved && testDelta.before > 0
			? `\n\n## Test progress\nTests still failing with same count (${testDelta.after} failures). The previous repair did not address the root cause.`
			: '';

	return `Repair turn ${index} of ${maxTurns}.

The previous verification failed. Propose one small repair as JSON with optional files, patches, and scratchpad fields. Prefer patches. Touch the failing path unless the stack trace clearly points elsewhere.
${taskSection}${diagnosticsSection}${wrongPathSection}${testDeltaSection}
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

const MAX_IMPORTED_CONTEXT_FILES = 5;
const MAX_IMPORTED_CONTEXT_BYTES = 24_000;

// D6: pull relative import targets of in-context files into the repair
// context. Only relative specifiers are considered, resolution is jailed to
// the workspace, and additions are capped by count and total bytes.
async function addImportedSourceFiles(cwd, contextFiles) {
	const importPattern =
		/(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/gu;
	const seeds = [...contextFiles.entries()];
	let added = 0;
	let addedBytes = 0;
	for (const [fromPath, content] of seeds) {
		for (const match of content.matchAll(importPattern)) {
			if (added >= MAX_IMPORTED_CONTEXT_FILES) return;
			for (const candidate of resolveRelativeImport(cwd, fromPath, match[1])) {
				if (contextFiles.has(candidate)) break;
				const fileContent = await readFileIfExists(cwd, candidate);
				if (fileContent === null) continue;
				if (addedBytes + fileContent.length > MAX_IMPORTED_CONTEXT_BYTES) {
					break;
				}
				contextFiles.set(candidate, fileContent);
				added += 1;
				addedBytes += fileContent.length;
				break;
			}
		}
	}
}

// Resolve a relative import specifier against the importing file's directory.
// Returns cwd-relative candidate paths inside the workspace (empty when the
// specifier escapes the workspace). Extensionless specifiers try .mjs and .js.
function resolveRelativeImport(cwd, fromPath, specifier) {
	const fromDir = dirname(join(cwd, fromPath));
	const target = normalize(join(fromDir, specifier));
	const root = normalize(cwd + sep);
	if (!target.startsWith(root)) return [];
	const relativePath = target.slice(root.length).replaceAll('\\', '/');
	if (!relativePath) return [];
	if (/\.[cm]?[jt]s$/u.test(relativePath)) return [relativePath];
	return [`${relativePath}.mjs`, `${relativePath}.js`];
}

function siblingSourcePath(path) {
	if (path.endsWith('.test.js')) return path.replace(/\.test\.js$/u, '.js');
	if (path.endsWith('.test.mjs')) return path.replace(/\.test\.mjs$/u, '.mjs');
	if (path.endsWith('-test.js')) return path.replace(/-test\.js$/u, '.js');
	if (path.endsWith('-test.mjs')) return path.replace(/-test\.mjs$/u, '.mjs');
	return '';
}

// F6: returns file content when the file exists and is readable, null otherwise.
// Used by buildRepairContext so ghost paths are never included in repair context.
async function readFileIfExists(cwd, path) {
	try {
		return await readFile(join(cwd, path), 'utf8');
	} catch {
		return null;
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

// The set of paths a repair may legitimately touch: failing-test paths plus
// every file included in the repair context (siblings, imported sources).
function allowedRepairPaths(repairContext) {
	const allowed = new Set(repairContext.failurePaths);
	for (const file of repairContext.files || []) {
		allowed.add(file.path);
	}
	return [...allowed];
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
