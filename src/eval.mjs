import { createHash } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runVerification } from './verification-runner.mjs';

export class EvalError extends Error {
	constructor(message) {
		super(message);
		this.name = 'EvalError';
	}
}

const ASSERTION_TYPES = new Set([
	'files_exist',
	'content_matches',
	'tests_pass',
]);

const WORKSPACE_ONLY_ASSERTION_TYPES = new Set([
	'file_modified',
	'file_unchanged',
	'files_absent',
	'content_absent',
]);

const ALL_ASSERTION_TYPES = new Set([
	...ASSERTION_TYPES,
	...WORKSPACE_ONLY_ASSERTION_TYPES,
]);

export function loadEvalSuite(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new EvalError('Eval suite must be valid JSON');
	}

	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new EvalError('Eval suite must be a JSON object');
	}

	if (typeof raw.name !== 'string' || !raw.name) {
		throw new EvalError('Eval suite requires a non-empty "name" string');
	}

	if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
		throw new EvalError('Eval suite requires a non-empty "cases" array');
	}

	return {
		name: raw.name,
		description: typeof raw.description === 'string' ? raw.description : '',
		cases: raw.cases.map((c, i) => validateCase(c, i)),
	};
}

export function isWorkspaceCase(evalCase) {
	return Boolean(evalCase.fixture);
}

function validateCase(c, index) {
	if (!c || typeof c !== 'object' || Array.isArray(c)) {
		throw new EvalError(`Case at index ${index} must be an object`);
	}
	if (typeof c.id !== 'string' || !c.id) {
		throw new EvalError(
			`Case at index ${index} requires a non-empty "id" string`,
		);
	}
	if (typeof c.prompt !== 'string' || !c.prompt) {
		throw new EvalError(`Case "${c.id}" requires a non-empty "prompt" string`);
	}
	if (!Array.isArray(c.assertions)) {
		throw new EvalError(`Case "${c.id}" requires an "assertions" array`);
	}

	const isWorkspace = typeof c.fixture === 'string' && c.fixture.length > 0;

	const assertions = c.assertions.map((a, i) =>
		validateAssertion(a, c.id, i, isWorkspace),
	);

	if (!isWorkspace) {
		return {
			id: c.id,
			model: typeof c.model === 'string' ? c.model : '',
			prompt: c.prompt,
			assertions,
		};
	}

	if (typeof c.test !== 'string' || !c.test) {
		throw new EvalError(
			`Workspace case "${c.id}" requires a non-empty "test" string`,
		);
	}

	const requires = Array.isArray(c.requires)
		? c.requires.filter((r) => typeof r === 'string' && r.length > 0)
		: [];

	return {
		id: c.id,
		model: typeof c.model === 'string' ? c.model : '',
		prompt: c.prompt,
		assertions,
		fixture: c.fixture,
		test: c.test,
		requires,
		expectFailingBaseline: c.expectFailingBaseline === true,
		heal: c.heal !== undefined ? c.heal : 'inherit',
	};
}

function validateAssertion(a, caseId, index, isWorkspaceCase = false) {
	if (!a || typeof a !== 'object' || Array.isArray(a)) {
		throw new EvalError(
			`Assertion ${index} in case "${caseId}" must be an object`,
		);
	}
	if (!ALL_ASSERTION_TYPES.has(a.type)) {
		throw new EvalError(
			`Assertion ${index} in case "${caseId}" has unknown type: ${a.type}. Valid: ${[...ALL_ASSERTION_TYPES].join(', ')}`,
		);
	}
	if (!isWorkspaceCase && WORKSPACE_ONLY_ASSERTION_TYPES.has(a.type)) {
		throw new EvalError(
			`Assertion ${index} in case "${caseId}" uses workspace-only type "${a.type}" but case has no "fixture" field`,
		);
	}

	if (a.type === 'files_exist') {
		if (!Array.isArray(a.paths) || a.paths.length === 0) {
			throw new EvalError(
				`files_exist in case "${caseId}" requires non-empty "paths" array`,
			);
		}
		return { type: 'files_exist', paths: [...a.paths] };
	}

	if (a.type === 'content_matches') {
		if (typeof a.path !== 'string' || !a.path) {
			throw new EvalError(
				`content_matches in case "${caseId}" requires "path" string`,
			);
		}
		if (typeof a.pattern !== 'string' || !a.pattern) {
			throw new EvalError(
				`content_matches in case "${caseId}" requires "pattern" string`,
			);
		}
		return { type: 'content_matches', path: a.path, pattern: a.pattern };
	}

	if (a.type === 'tests_pass') {
		if (typeof a.command !== 'string' || !a.command) {
			throw new EvalError(
				`tests_pass in case "${caseId}" requires "command" string`,
			);
		}
		return { type: 'tests_pass', command: a.command };
	}

	if (a.type === 'file_modified') {
		if (typeof a.path !== 'string' || !a.path) {
			throw new EvalError(
				`file_modified in case "${caseId}" requires "path" string`,
			);
		}
		return { type: 'file_modified', path: a.path };
	}

	if (a.type === 'file_unchanged') {
		if (typeof a.path !== 'string' || !a.path) {
			throw new EvalError(
				`file_unchanged in case "${caseId}" requires "path" string`,
			);
		}
		return { type: 'file_unchanged', path: a.path };
	}

	if (a.type === 'files_absent') {
		if (!Array.isArray(a.paths) || a.paths.length === 0) {
			throw new EvalError(
				`files_absent in case "${caseId}" requires non-empty "paths" array`,
			);
		}
		return { type: 'files_absent', paths: [...a.paths] };
	}

	// content_absent
	if (typeof a.path !== 'string' || !a.path) {
		throw new EvalError(
			`content_absent in case "${caseId}" requires "path" string`,
		);
	}
	if (typeof a.pattern !== 'string' || !a.pattern) {
		throw new EvalError(
			`content_absent in case "${caseId}" requires "pattern" string`,
		);
	}
	return { type: 'content_absent', path: a.path, pattern: a.pattern };
}

// Check a single assertion against a proposal object.
// proposal: { files: [{path, content}], patches: [{path,...}], ... } or null
export async function runAssertion(assertion, proposal, timeoutMs = 60000) {
	const files = proposal?.files ?? [];
	const patches = proposal?.patches ?? [];

	if (assertion.type === 'files_exist') {
		const proposed = new Set([
			...files.map((f) => f.path),
			...patches.map((p) => p.path),
		]);
		const missing = assertion.paths.filter((p) => !proposed.has(p));
		return {
			type: assertion.type,
			ok: missing.length === 0,
			detail:
				missing.length === 0
					? 'all paths present in proposal'
					: `missing from proposal: ${missing.join(', ')}`,
		};
	}

	if (assertion.type === 'content_matches') {
		const file = files.find((f) => f.path === assertion.path);
		if (!file) {
			return {
				type: assertion.type,
				ok: false,
				detail: `file not in proposal: ${assertion.path}`,
			};
		}
		let pattern;
		try {
			pattern = new RegExp(assertion.pattern, 'u');
		} catch {
			return {
				type: assertion.type,
				ok: false,
				detail: `invalid regex pattern: ${assertion.pattern}`,
			};
		}
		const matched = pattern.test(file.content);
		return {
			type: assertion.type,
			ok: matched,
			detail: matched
				? `pattern matched in ${assertion.path}`
				: `pattern not found in ${assertion.path}: ${assertion.pattern}`,
		};
	}

	// tests_pass: write proposal files to a temp dir and run tests there
	if (!files.length) {
		return {
			type: assertion.type,
			ok: false,
			detail: 'no files in proposal to run tests against',
		};
	}
	const tmpDir = await mkdtemp(join(tmpdir(), 'kodr-eval-'));
	try {
		for (const file of files) {
			const dest = join(tmpDir, file.path);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, file.content, 'utf8');
		}
		const result = await runVerification(tmpDir, assertion.command, {
			timeoutMs,
		});
		return {
			type: assertion.type,
			ok: result.ok,
			detail: result.ok
				? `tests passed (exit ${result.exitCode})`
				: `tests failed (exit ${result.exitCode})`,
			stdout: result.stdout.slice(0, 500),
			stderr: result.stderr.slice(0, 200),
		};
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}

// Score a single eval case against a proposal.
// Returns { id, ok, score, assertions, passCount, totalCount }
export async function scoreCase(evalCase, proposal, timeoutMs) {
	const assertionResults = [];
	for (const assertion of evalCase.assertions) {
		assertionResults.push(await runAssertion(assertion, proposal, timeoutMs));
	}
	const passCount = assertionResults.filter((r) => r.ok).length;
	const totalCount = assertionResults.length;
	const score = totalCount > 0 ? passCount / totalCount : 1;
	return {
		assertions: assertionResults,
		id: evalCase.id,
		ok: passCount === totalCount,
		passCount,
		score,
		totalCount,
	};
}

// Hash a file's content for baseline tracking.
export async function hashFile(filePath) {
	try {
		const content = await readFile(filePath);
		return createHash('sha256').update(content).digest('hex');
	} catch {
		return null;
	}
}

// Check a single workspace assertion against a staged directory on disk.
// baselineHashes: Map<relativePath, sha256hex> captured before the run.
export async function runWorkspaceAssertion(
	assertion,
	workspaceDir,
	baselineHashes,
	timeoutMs = 60000,
) {
	if (assertion.type === 'tests_pass') {
		const result = await runVerification(workspaceDir, assertion.command, {
			timeoutMs,
		});
		return {
			type: assertion.type,
			ok: result.ok,
			detail: result.ok
				? `tests passed (exit ${result.exitCode})`
				: `tests failed (exit ${result.exitCode})`,
			stdout: result.stdout.slice(0, 500),
			stderr: result.stderr.slice(0, 200),
		};
	}

	if (assertion.type === 'files_exist') {
		const missing = [];
		for (const p of assertion.paths) {
			try {
				await stat(join(workspaceDir, p));
			} catch {
				missing.push(p);
			}
		}
		return {
			type: assertion.type,
			ok: missing.length === 0,
			detail:
				missing.length === 0
					? 'all paths exist on disk'
					: `missing from workspace: ${missing.join(', ')}`,
		};
	}

	if (assertion.type === 'content_matches') {
		let content;
		try {
			content = await readFile(join(workspaceDir, assertion.path), 'utf8');
		} catch {
			return {
				type: assertion.type,
				ok: false,
				detail: `file not found: ${assertion.path}`,
			};
		}
		let pattern;
		try {
			pattern = new RegExp(assertion.pattern, 'u');
		} catch {
			return {
				type: assertion.type,
				ok: false,
				detail: `invalid regex pattern: ${assertion.pattern}`,
			};
		}
		const matched = pattern.test(content);
		return {
			type: assertion.type,
			ok: matched,
			detail: matched
				? `pattern matched in ${assertion.path}`
				: `pattern not found in ${assertion.path}: ${assertion.pattern}`,
		};
	}

	if (assertion.type === 'file_modified') {
		const baseline = baselineHashes.get(assertion.path);
		const current = await hashFile(join(workspaceDir, assertion.path));
		if (current === null) {
			return {
				type: assertion.type,
				ok: false,
				detail: `file not found after run: ${assertion.path}`,
			};
		}
		if (baseline === undefined) {
			return {
				type: assertion.type,
				ok: false,
				detail: `file was not in the staged baseline: ${assertion.path}`,
			};
		}
		const changed = current !== baseline;
		return {
			type: assertion.type,
			ok: changed,
			detail: changed
				? `file was modified: ${assertion.path}`
				: `file was not modified: ${assertion.path}`,
		};
	}

	if (assertion.type === 'file_unchanged') {
		const baseline = baselineHashes.get(assertion.path);
		const current = await hashFile(join(workspaceDir, assertion.path));
		if (current === null) {
			return {
				type: assertion.type,
				ok: false,
				detail: `file not found after run: ${assertion.path}`,
			};
		}
		if (baseline === undefined) {
			return {
				type: assertion.type,
				ok: false,
				detail: `file was not in the staged baseline: ${assertion.path}`,
			};
		}
		const unchanged = current === baseline;
		return {
			type: assertion.type,
			ok: unchanged,
			detail: unchanged
				? `file was not modified (as expected): ${assertion.path}`
				: `file was unexpectedly modified: ${assertion.path}`,
		};
	}

	if (assertion.type === 'files_absent') {
		const present = [];
		for (const p of assertion.paths) {
			try {
				await stat(join(workspaceDir, p));
				present.push(p);
			} catch {
				// file absent — good
			}
		}
		return {
			type: assertion.type,
			ok: present.length === 0,
			detail:
				present.length === 0
					? 'all paths absent from workspace'
					: `unexpectedly present in workspace: ${present.join(', ')}`,
		};
	}

	// content_absent
	let content;
	try {
		content = await readFile(join(workspaceDir, assertion.path), 'utf8');
	} catch {
		return {
			type: assertion.type,
			ok: true,
			detail: `file not found (absent counts as pattern-absent): ${assertion.path}`,
		};
	}
	let pattern;
	try {
		pattern = new RegExp(assertion.pattern, 'u');
	} catch {
		return {
			type: assertion.type,
			ok: false,
			detail: `invalid regex pattern: ${assertion.pattern}`,
		};
	}
	const matched = pattern.test(content);
	return {
		type: assertion.type,
		ok: !matched,
		detail: !matched
			? `pattern absent from ${assertion.path}`
			: `pattern still present in ${assertion.path}: ${assertion.pattern}`,
	};
}

// Score a workspace case against a staged directory on disk.
export async function scoreWorkspaceCase(
	evalCase,
	workspaceDir,
	baselineHashes,
	timeoutMs,
) {
	const assertionResults = [];
	for (const assertion of evalCase.assertions) {
		assertionResults.push(
			await runWorkspaceAssertion(
				assertion,
				workspaceDir,
				baselineHashes,
				timeoutMs,
			),
		);
	}
	const passCount = assertionResults.filter((r) => r.ok).length;
	const totalCount = assertionResults.length;
	const score = totalCount > 0 ? passCount / totalCount : 1;
	return {
		assertions: assertionResults,
		id: evalCase.id,
		ok: passCount === totalCount,
		passCount,
		score,
		totalCount,
	};
}
