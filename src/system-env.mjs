// system-env.mjs — environment facts, behaviours, and tool-description blocks
// for the Kodr system prompt.
//
// Design rules:
// - All functions are pure or capture facts exactly once per session.
// - renderEnvironmentBlock() is byte-stable when called with the same facts
//   (safe for prompt-prefix caching, phase 87).
// - renderBehavioursBlock() and renderToolsBlock() are always pure/constant.
// - No new runtime dependencies; Node.js 24 built-ins only.

import { basename } from 'node:path';
import { release } from 'node:os';
import { runGit } from './git-workspace.mjs';

/**
 * Captures environment facts once per session. Call this once and pass the
 * result to renderEnvironmentBlock() on every system-prompt build so the block
 * is byte-stable across repeated calls within a session.
 *
 * @param {string} cwd  Absolute workspace path.
 * @param {{ model?: string }} [options]
 * @returns {Promise<EnvironmentFacts>}
 */
export async function captureEnvironmentFacts(cwd, options = {}) {
	const gitInfo = await detectGitInfo(cwd);
	return {
		cwd,
		date: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
		gitBranch: gitInfo.branch,
		gitRepo: gitInfo.isRepo,
		model: options.model || '',
		nodeVersion: process.version,
		platform: process.platform,
		osRelease: release(),
		shell: shellBasename(),
	};
}

/**
 * Renders a compact `# Environment` block from pre-captured facts.
 * Byte-stable for a given facts object.
 *
 * @param {EnvironmentFacts} facts
 * @returns {string}
 */
export function renderEnvironmentBlock(facts) {
	const gitLine = facts.gitRepo
		? `yes (branch ${facts.gitBranch || 'unknown'})`
		: 'no';
	const lines = [
		'# Environment',
		`- cwd: ${facts.cwd}`,
		`- git repository: ${gitLine}`,
		`- platform: ${facts.platform} (${facts.osRelease}), shell: ${facts.shell}`,
		`- node: ${facts.nodeVersion}`,
		`- date: ${facts.date}`,
	];
	if (facts.model) {
		lines.push(`- model: ${facts.model}`);
	}
	return lines.join('\n');
}

/**
 * Returns the `# Behaviours` section. Pure and constant — every line is
 * traceable to a failures.jsonl entry.
 *
 * Evidence traceability:
 * - ONE envelope: gemma multi-block narration (phase 111/113-dogfood)
 * - claim success: goal-substitution heal (phase 113-dogfood)
 * - repeat identical call: repeat-call short-circuit (phase 109)
 * - write proposal: turn-budget exhaustion (phase 109)
 *
 * @returns {string}
 */
export function renderBehavioursBlock() {
	return [
		'# Behaviours',
		'- Return exactly ONE JSON envelope per response, containing the COMPLETE files/patches for the task. Never split work across multiple JSON blocks or defer code to a later response.',
		'- If verification or tests fail, say so in messages — never claim success.',
		'- If a tool call fails or returns nothing useful, change your approach — do not repeat the identical call.',
		'- When you have enough information to write the proposal, write it — do not keep exploring.',
	].join('\n');
}

/**
 * Returns the `# Tools` section. Only include this when tools are enabled.
 * The wording adapts to the resolved toolWritesMode (T4, phase 118):
 *   'native'   — capture tools are the primary write channel; make them explicit.
 *   'envelope' — capture tools not declared; no write-tool lines shown.
 *   'auto'     — 117 neutral wording (both channels described).
 *
 * Byte-stable per session when called with the same mode each time.
 *
 * @param {'native'|'envelope'|'auto'} [toolWritesMode='auto']
 * @returns {string}
 */
export function renderToolsBlock(toolWritesMode = 'auto') {
	const baseTools = [
		'# Tools',
		'- `inspect_symbols` — compact structural map of the workspace; use first to orient.',
		'- `find_references` — symbol references across files.',
		'- `read_file` — raw file text; read before you patch.',
		'- `read_skill_resource` — declared skill resource content.',
		'- `run_skill_command` — declared skill helper commands (explicit approval required).',
		'- `run_command` — allowlisted verification commands only.',
	];

	if (toolWritesMode === 'native') {
		// T4 native: capture tools are the primary write path. Envelope carries
		// status/messages only — files/patches arrays may be empty.
		return [
			...baseTools,
			'- `write_file {path, content}` — write a complete file. Use this for every file change.',
			'- `edit_file {path, search, replace}` — search-and-replace edit. Use this for every file change.',
			'',
			'Use write_file or edit_file for every file change. The final JSON envelope carries status and messages only — files/patches arrays may be empty.',
			'Workflow: inspect → read → write_file/edit_file → the harness applies and verifies.',
			'You have a limited number of tool turns; finish writing before they run out.',
		].join('\n');
	}

	if (toolWritesMode === 'envelope') {
		// T4 envelope: capture tools not declared; no write-tool lines.
		return [
			...baseTools,
			'',
			'Return a final JSON envelope with files/patches arrays containing all file changes.',
			'Workflow: inspect → read → return JSON envelope → the harness applies and verifies.',
			'You have a limited number of tool turns; finish reading before they run out.',
		].join('\n');
	}

	// 'auto': 117 neutral wording (both channels described).
	return [
		...baseTools,
		'- `write_file {path, content}` — propose a complete file write; recorded as a proposal entry, applied after verification.',
		'- `edit_file {path, search, replace}` — propose a search-and-replace edit; recorded as a proposal entry, applied after verification.',
		'',
		'Use write_file or edit_file to propose file changes. You may also return a final JSON envelope with files/patches arrays — both channels work; the harness merges them.',
		'Workflow: inspect → read → write_file/edit_file (or envelope) → the harness applies and verifies.',
		'You have a limited number of tool turns; finish writing before they run out.',
	].join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function detectGitInfo(cwd) {
	try {
		const result = await runGit(cwd, [
			'rev-parse',
			'--is-inside-work-tree',
		]).catch(() => null);
		if (!result || result.exitCode !== 0 || result.stdout.trim() !== 'true') {
			return { branch: null, isRepo: false };
		}
		const branchResult = await runGit(cwd, [
			'rev-parse',
			'--abbrev-ref',
			'HEAD',
		]).catch(() => null);
		const branch =
			branchResult?.exitCode === 0 ? branchResult.stdout.trim() : null;
		return { branch, isRepo: true };
	} catch {
		return { branch: null, isRepo: false };
	}
}

function shellBasename() {
	const shellEnv = process.env.SHELL || '';
	return shellEnv ? basename(shellEnv) : 'unknown';
}

/**
 * @typedef {Object} EnvironmentFacts
 * @property {string} cwd
 * @property {string} date         YYYY-MM-DD, captured at session start
 * @property {string|null} gitBranch
 * @property {boolean} gitRepo
 * @property {string} model
 * @property {string} nodeVersion
 * @property {string} osRelease
 * @property {string} platform
 * @property {string} shell
 */
