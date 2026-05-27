import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
	return {
		id: c.id,
		model: typeof c.model === 'string' ? c.model : '',
		prompt: c.prompt,
		assertions: c.assertions.map((a, i) => validateAssertion(a, c.id, i)),
	};
}

function validateAssertion(a, caseId, index) {
	if (!a || typeof a !== 'object' || Array.isArray(a)) {
		throw new EvalError(
			`Assertion ${index} in case "${caseId}" must be an object`,
		);
	}
	if (!ASSERTION_TYPES.has(a.type)) {
		throw new EvalError(
			`Assertion ${index} in case "${caseId}" has unknown type: ${a.type}. Valid: ${[...ASSERTION_TYPES].join(', ')}`,
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

	// tests_pass
	if (typeof a.command !== 'string' || !a.command) {
		throw new EvalError(
			`tests_pass in case "${caseId}" requires "command" string`,
		);
	}
	return { type: 'tests_pass', command: a.command };
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
