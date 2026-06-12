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
		'- Return exactly ONE JSON envelope per response. Never narrate a sequence of JSON blocks.',
		'- If verification or tests fail, say so in messages — never claim success.',
		'- If a tool call fails or returns nothing useful, change your approach — do not repeat the identical call.',
		'- When you have enough information to write the proposal, write it — do not keep exploring.',
	].join('\n');
}

/**
 * Returns the `# Tools` section. Only include this when tools are enabled.
 * Pure and constant within a session.
 *
 * @returns {string}
 */
export function renderToolsBlock() {
	return [
		'# Tools',
		'- `inspect_symbols` — compact structural map of the workspace; use first to orient.',
		'- `find_references` — symbol references across files.',
		'- `read_file` — raw file text; read before you patch.',
		'- `read_skill_resource` — declared skill resource content.',
		'- `run_skill_command` — declared skill helper commands (explicit approval required).',
		'- `run_command` — allowlisted verification commands only.',
		'',
		'Workflow: inspect → read → patch/files → verify.',
		'You have a limited number of tool turns; finish with the envelope before they run out.',
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
