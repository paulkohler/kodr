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
import { getBuiltinSkill } from './builtin-skills.mjs';
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
 * - exact paths: wrong-path writes (note-linker to repo root phase 57-example;
 *   nemotron root utils.js vs tests/utils.js phase 62; repair wrote wordfreq.mjs
 *   while tests lived in test/wordfreq.test.mjs phase 72/73/109-dogfood)
 * - imports match exports: cross-file contract drift (escapeHtml imported but
 *   not exported phase 146-trial; named import from CJS / missing listLinks in
 *   import then dynamic-import workaround phase 155-stress/204-url-shortener;
 *   test imports symbols impl never exports phase 113-validation)
 *
 * @returns {string}
 */
export function renderBehavioursBlock() {
	return [
		'# Behaviours',
		'- Return exactly ONE JSON envelope per response. Include COMPLETE file content — never placeholders or "rest unchanged". In staged execution, complete only the current stage slice; the harness will prompt for the next stage.',
		'- If verification or tests fail, say so in messages — never claim success.',
		'- If a tool call fails or returns nothing useful, change your approach — do not repeat the identical call.',
		'- When you have enough information to write the proposal, write it — do not keep exploring.',
		'- Write the exact file path the task names; to fix a failing test, edit the file in the failure, not a new sibling file.',
		'- Every imported name must be exported by the file it comes from; keep imports and exports in sync across files.',
		'- When you import a third-party package, declare it in `package.json` `dependencies` in the same response — never import a package that has no `package.json` entry.',
	].join('\n');
}

/**
 * Filters lang:node skill sections by task relevance. The preamble (content
 * before the first ## header) is always included. Each ## section is included
 * when no gate rule matches the header, or when the task context satisfies the
 * gate's keyword pattern.
 *
 * Gate rules (matched against lowercased header):
 *   "sqlite" → include if taskContext matches
 *              /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/i
 *   "http"   → include if taskContext matches /express|node:http|http\.create|server\.listen|app\.listen/i
 *   "busboy" → include if taskContext matches /busboy|multipart|upload/i
 *   other    → always include (test-isolation section, etc.)
 *
 * Passing an empty taskContext disables filtering (all sections returned).
 *
 * @param {string} body        Full skill body
 * @param {string} taskContext Task prompt text
 * @returns {string}
 */
export function gateLanguageGuidance(body, taskContext) {
	if (!taskContext) return body;
	const preambleEnd = body.search(/^## /mu);
	if (preambleEnd === -1) return body;
	const preamble = body.slice(0, preambleEnd);
	const sections = body.slice(preambleEnd).split(/(?=^## )/mu);
	const kept = [preamble];
	for (const section of sections) {
		if (!section.trim()) continue;
		const header = (section.match(/^## (.+)/u)?.[1] ?? '').toLowerCase();
		let gate;
		if (header.includes('sqlite')) {
			gate = /sqlite|DatabaseSync|CREATE TABLE|FTS5|:memory:|node:sqlite/iu;
		} else if (header.includes('http')) {
			gate = /express|node:http|http\.create|server\.listen|app\.listen/iu;
		} else if (header.includes('busboy')) {
			gate = /busboy|multipart|upload/iu;
		}
		if (!gate || gate.test(taskContext)) {
			kept.push(section);
		}
	}
	return kept.join('').trimEnd();
}

/**
 * Returns the `# Node.js / ESM Contract` block when the workspace signals
 * a Node/ESM project, otherwise returns ''.
 *
 * The content is sourced from the builtin `lang:node` skill
 * (`src/builtin-skills/languages/node/SKILL.md`, phase 122) — a single
 * markdown source of truth, not hardcoded prose. A caller may pass a resolved
 * `guidance` string (e.g. a project/user `lang:node` override discovered via
 * the skill tiers) to shadow the builtin; the builtin body is the default.
 *
 * Signal: `package.json` with `"type":"module"`, OR any `.mjs` file in the
 * workspace file list, OR a task prompt naming a `.mjs`/`.cjs` target. Computed
 * once at session start and captured in `facts.isNodeEsm` (byte-stable).
 *
 * When `facts.taskContext` is provided and the language is `node`, the body is
 * filtered through `gateLanguageGuidance` to strip SQLite/HTTP/busboy sections
 * not relevant to the task. Empty taskContext returns the full unfiltered body.
 *
 * Content is terse and evidence-traceable (≤4 lines):
 * 1. ESM only — import/export; no require/module.exports; no top-level return.
 *    (gpt-oss CJS-in-ESM, devstral illegal return — phases 117/119-validation)
 * 2. Tests use the real node:test API — no invented methods.
 *    (devstral t.assert() — phase 119-devstral)
 * 3. CLI argv arrives as separate tokens — parse flags accordingly.
 *    (devstral --top regex — phase 119/120-validation)
 *
 * The builtin body carries a trailing newline; `.trim()` makes the rendered
 * block byte-identical to the phase-121 hardcoded block (prefix stability).
 *
 * @param {{ language?: string, isNodeEsm?: boolean, guidance?: string, taskContext?: string }} [facts]
 * @returns {string}
 */
export function renderLanguageGuidanceBlock(facts) {
	// Accept { language } (new) or { isNodeEsm } (legacy) — both resolve to a language tag.
	const language = facts?.language ?? (facts?.isNodeEsm ? 'node' : null);
	if (!language) return '';
	let builtinBody = '';
	if (!(typeof facts.guidance === 'string' && facts.guidance.trim())) {
		try {
			builtinBody = getBuiltinSkill(`lang:${language}`).body;
		} catch {
			return ''; // no builtin for this language
		}
	}
	const guidance =
		typeof facts.guidance === 'string' && facts.guidance.trim()
			? facts.guidance
			: builtinBody;
	const body = guidance.trim();
	if (language === 'node' && facts?.taskContext) {
		return gateLanguageGuidance(body, facts.taskContext);
	}
	return body;
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
		'- `read_file` — raw file text. Read every existing file before you edit or patch it — never patch a file you have not read this turn.',
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

	// 'auto': prefer tool calls; envelope carries status/messages only.
	return [
		...baseTools,
		'- `write_file {path, content}` — write a complete file; applied immediately.',
		'- `edit_file {path, search, replace}` — search-and-replace edit; applied immediately.',
		'',
		'Prefer write_file/edit_file tool calls for all file changes. Keep the final JSON envelope for status and messages; leave its files/patches arrays empty if you used the tools. Do not emit the same write through both channels.',
		'Required order: 1) inspect_symbols to orient, 2) read_file every file you will touch, 3) write_file/edit_file. Skipping step 2 produces wrong patches.',
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
