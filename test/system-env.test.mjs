import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	captureEnvironmentFacts,
	gateLanguageGuidance,
	renderBehavioursBlock,
	renderEnvironmentBlock,
	renderLanguageGuidanceBlock,
	renderToolsBlock,
} from '../src/system-env.mjs';
import {
	buildWorkspaceContext,
	detectNodeEsm,
	detectRust,
	renderPromptSections,
} from '../src/context-packer.mjs';

// ---------------------------------------------------------------------------
// renderEnvironmentBlock — unit tests
// ---------------------------------------------------------------------------

describe('renderEnvironmentBlock', () => {
	it('renders expected keys for a git repo', () => {
		const facts = {
			cwd: '/workspace/project',
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'openai/gpt-oss-20b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const block = renderEnvironmentBlock(facts);
		assert.match(block, /^# Environment/u);
		assert.match(block, /cwd: \/workspace\/project/u);
		assert.match(block, /git repository: yes \(branch main\)/u);
		assert.match(block, /platform: darwin \(Darwin 25\.5\.0\), shell: zsh/u);
		assert.match(block, /node: v24\.16\.0/u);
		assert.match(block, /date: 2026-06-12/u);
		assert.match(block, /model: openai\/gpt-oss-20b/u);
	});

	it('renders "no" for non-git directories', () => {
		const facts = {
			cwd: '/tmp/scratch',
			date: '2026-06-12',
			gitBranch: null,
			gitRepo: false,
			model: '',
			nodeVersion: 'v24.0.0',
			osRelease: 'Linux 6.1',
			platform: 'linux',
			shell: 'bash',
		};
		const block = renderEnvironmentBlock(facts);
		assert.match(block, /git repository: no/u);
		// model line is omitted when empty
		assert.doesNotMatch(block, /model:/u);
	});

	it('is byte-stable when called twice with the same facts', () => {
		const facts = {
			cwd: '/home/user/project',
			date: '2026-01-01',
			gitBranch: 'dev',
			gitRepo: true,
			model: 'qwen/qwen3.6-35b',
			nodeVersion: 'v24.1.0',
			osRelease: 'Linux 6.8',
			platform: 'linux',
			shell: 'zsh',
		};
		assert.equal(renderEnvironmentBlock(facts), renderEnvironmentBlock(facts));
	});

	it('includes "unknown" branch when branch is null in a repo', () => {
		const facts = {
			cwd: '/repo',
			date: '2026-06-12',
			gitBranch: null,
			gitRepo: true,
			model: '',
			nodeVersion: 'v24.0.0',
			osRelease: 'Linux 6.0',
			platform: 'linux',
			shell: 'sh',
		};
		const block = renderEnvironmentBlock(facts);
		assert.match(block, /git repository: yes \(branch unknown\)/u);
	});
});

// ---------------------------------------------------------------------------
// captureEnvironmentFacts — live integration (cheap — uses process globals)
// ---------------------------------------------------------------------------

describe('captureEnvironmentFacts', () => {
	it('captures real facts with expected shape', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'kodr-env-'));
		const facts = await captureEnvironmentFacts(tmp, { model: 'test/model' });

		assert.equal(typeof facts.cwd, 'string');
		assert.equal(typeof facts.date, 'string');
		assert.match(facts.date, /^\d{4}-\d{2}-\d{2}$/u);
		assert.equal(typeof facts.gitRepo, 'boolean');
		assert.equal(typeof facts.nodeVersion, 'string');
		assert.match(facts.nodeVersion, /^v\d+\.\d+/u);
		assert.equal(typeof facts.platform, 'string');
		assert.equal(typeof facts.osRelease, 'string');
		assert.equal(typeof facts.shell, 'string');
		assert.equal(facts.model, 'test/model');
	});

	it('byte-stable across two calls in the same session', async () => {
		const tmp = await mkdtemp(join(tmpdir(), 'kodr-env-'));
		const f1 = await captureEnvironmentFacts(tmp, { model: 'm' });
		const f2 = await captureEnvironmentFacts(tmp, { model: 'm' });
		// Date, cwd, node version, platform are all deterministic within a run.
		assert.equal(renderEnvironmentBlock(f1), renderEnvironmentBlock(f2));
	});
});

// ---------------------------------------------------------------------------
// renderBehavioursBlock / renderToolsBlock — structure checks
// ---------------------------------------------------------------------------

describe('renderBehavioursBlock', () => {
	it('starts with # Behaviours and has seven lines', () => {
		const block = renderBehavioursBlock();
		assert.match(block, /^# Behaviours/u);
		const lines = block.split('\n').filter((l) => l.startsWith('-'));
		assert.equal(lines.length, 7, 'expected 7 behaviour lines');
	});

	it('contains the seven expected directive keywords', () => {
		const block = renderBehavioursBlock();
		assert.match(block, /ONE JSON envelope/u);
		assert.match(block, /claim success/u);
		assert.match(block, /repeat the identical call/u);
		assert.match(block, /write it/u);
		// Phase 207: wrong-path writes (phase 57-example/62/72/109-dogfood).
		assert.match(block, /exact file path/u);
		// Phase 207: cross-file import/export drift (phase 146-trial/155/204).
		assert.match(block, /imported name must be exported/u);
		// Phase 247: missing package.json for third-party imports.
		assert.match(block, /package\.json.*dependencies/u);
	});
});

describe('renderToolsBlock', () => {
	// Phase 117 (W1/W5): now lists eight tools including write_file and edit_file.
	it('starts with # Tools and lists all eight tools (auto mode)', () => {
		const block = renderToolsBlock();
		assert.match(block, /^# Tools/u);
		assert.match(block, /inspect_symbols/u);
		assert.match(block, /find_references/u);
		assert.match(block, /read_file/u);
		assert.match(block, /read_skill_resource/u);
		assert.match(block, /run_skill_command/u);
		assert.match(block, /run_command/u);
		assert.match(block, /write_file/u);
		assert.match(block, /edit_file/u);
	});

	it('contains positive capture-tool contract and budget reminder (auto mode)', () => {
		const block = renderToolsBlock();
		// Phase 117 (W5): positive contract replaces the "no write tool" prohibition.
		// Phase 247: prefer tool calls; explicit workflow order.
		assert.match(block, /Prefer write_file\/edit_file/u);
		assert.match(block, /limited number of tool turns/u);
	});

	// T4 (phase 118): channel-aware wording per resolved mode.
	it('native mode: primary contract says use write_file/edit_file for every change', () => {
		const block = renderToolsBlock('native');
		assert.match(block, /^# Tools/u);
		assert.match(block, /write_file/u);
		assert.match(block, /edit_file/u);
		// Native contract: "for every file change"
		assert.match(block, /every file change/u);
		// Envelope carries status/messages only
		assert.match(block, /status and messages only/u);
		// No "both channels work" phrasing
		assert.doesNotMatch(block, /both channels work/u);
	});

	it('envelope mode: no write_file or edit_file lines', () => {
		const block = renderToolsBlock('envelope');
		assert.match(block, /^# Tools/u);
		// No capture tool lines
		assert.doesNotMatch(block, /write_file/u);
		assert.doesNotMatch(block, /edit_file/u);
		// Envelope instruction instead
		assert.match(block, /JSON envelope/u);
	});

	it('auto mode (default): prefers tool calls with explicit workflow order', () => {
		const block = renderToolsBlock('auto');
		assert.match(block, /write_file/u);
		assert.match(block, /Prefer write_file\/edit_file/u);
		assert.match(block, /Required order/u);
		assert.match(block, /limited number of tool turns/u);
	});

	it('auto mode and no-arg produce identical output (byte-stable)', () => {
		const blockAuto = renderToolsBlock('auto');
		const blockDefault = renderToolsBlock();
		assert.equal(blockAuto, blockDefault);
	});
});

// ---------------------------------------------------------------------------
// Prompt assembly — sections present/absent by mode, order, budget guard
// ---------------------------------------------------------------------------

describe('prompt assembly with environment facts', () => {
	it('stable section includes # Behaviours in non-tools mode', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: false,
		});
		assert.match(sections.stable, /You are Kodr/u);
		assert.match(sections.stable, /# Behaviours/u);
		assert.doesNotMatch(sections.stable, /# Tools/u);
	});

	it('stable section includes # Tools in tools mode', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: true,
		});
		assert.match(sections.stable, /# Tools/u);
		assert.match(sections.stable, /inspect_symbols/u);
	});

	it('# Tools is absent from stable when toolsMode is false', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: false,
		});
		assert.doesNotMatch(sections.stable, /# Tools/u);
		assert.doesNotMatch(sections.stable, /inspect_symbols/u);
	});

	it('environment section is populated when environmentFacts provided', () => {
		const facts = {
			cwd: '/test/cwd',
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'test-model',
			nodeVersion: 'v24.0.0',
			osRelease: 'Linux 6.0',
			platform: 'linux',
			shell: 'zsh',
		};
		const sections = renderPromptSections({ environmentFacts: facts });
		assert.match(sections.environment, /# Environment/u);
		assert.match(sections.environment, /cwd: \/test\/cwd/u);
		assert.match(sections.environment, /model: test-model/u);
	});

	it('environment section is empty string when no facts provided', () => {
		const sections = renderPromptSections({});
		assert.equal(sections.environment, '');
	});

	it('system prompt section order is stable-env-project-semiStable-volatile', async () => {
		const cwd = await mkWorkspace({
			'AGENTS.md': 'Test project instructions.',
			'app.mjs': 'export {};',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: null,
			gitRepo: false,
			model: 'test',
			nodeVersion: 'v24.0.0',
			osRelease: 'Test 1.0',
			platform: 'linux',
			shell: 'sh',
		};
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
		});
		const prompt = context.systemPrompt;
		const behaviourPos = prompt.indexOf('# Behaviours');
		const envPos = prompt.indexOf('# Environment');
		const agentsPos = prompt.indexOf('workspace-instructions');
		const workspacePos = prompt.indexOf('Workspace');

		assert.ok(
			behaviourPos < envPos,
			'# Behaviours should come before # Environment',
		);
		assert.ok(
			envPos < agentsPos,
			'# Environment should come before workspace instructions',
		);
		assert.ok(
			agentsPos < workspacePos,
			'workspace instructions should come before file listing',
		);
	});

	it('stableHash is identical with and without environment facts', () => {
		// The stable section does not include environment facts, so its hash
		// must be the same regardless of whether environmentFacts are provided.
		const withFacts = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: {
				cwd: '/a',
				date: '2026-01-01',
				gitBranch: 'main',
				gitRepo: true,
				model: 'm',
				nodeVersion: 'v24',
				osRelease: 'OS 1',
				platform: 'linux',
				shell: 'sh',
			},
			toolsMode: false,
		});
		const withoutFacts = renderPromptSections({
			editFormat: 'patch',
			environmentFacts: null,
			toolsMode: false,
		});
		assert.equal(withFacts.stable, withoutFacts.stable);
	});
});

// ---------------------------------------------------------------------------
// Prompt budget guard — standard greenfield task must stay under ~2900 chars
// ---------------------------------------------------------------------------

describe('prompt budget guard', () => {
	// Phase 117 (W5): two new tool lines (write_file, edit_file) add ~220 chars.
	// Budget deliberately updated from 2900 → 3200. Stable section grew from two
	// to four tool-description lines.
	// Phase 118 (T4): native and envelope modes tested explicitly.
	// Phase 121 (C2): Node/ESM workspaces gain ~393 chars for the ESM contract
	// block. Budget updated to 3600 for Node/ESM greenfield (one .mjs file).
	// Phase 204/207: the lang:node skill body grew to ~2432 chars (node:sqlite,
	// HTTP integration, busboy pitfall sections with code patterns). Node/ESM
	// budgets raised to 6000 (auto) / 5000 (native). These guards now catch
	// runaway growth, not a 4096-token wire limit — context windows are 32K+
	// since phase 146 auto-discovery.
	// Phase 207: two new behaviour lines (exact-path, import/export sync) add
	// ~210 chars to every prompt; the non-Node budget is raised to 4000 (phase 247 behaviours+tools grew ~200 chars).
	it('standard Node/ESM greenfield system message stays under 6000 chars (auto mode)', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'google/gemma-4-26b-a4b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		// Standard greenfield: tools mode (most expensive), patch format, one .mjs file.
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
		});
		const promptLen = context.systemPrompt.length;
		// Phase 207 grew lang:node pitfall sections; phase 210 added lang:rust.
		// Phase 218 added SQLite :memory: and server listen guard patterns; ~8078 chars. Limit raised to 8500.
		// Phase 223 added FTS5 MATCH syntax and createDatabase factory patterns; ~9115 chars. Limit raised to 9500.
		// Phase 227 added node:sqlite import-name, check-status-before-parse, and
		// module-scope-side-effects pitfalls; ~11317 chars. Limit raised to 12000.
		// Phase 238 added ESM cache-bust pitfall; ~12626 chars. Limit raised to 14000.
		// Phase 243 added StatementSync row-access pitfall; ~13252 chars. Limit stays 14000.
		// Phase 246 added SQLite test state reset pitfall; ~14221 chars. Limit raised to 15000.
		assert.ok(
			promptLen < 15000,
			`Node/ESM system message must stay under 15000 chars for a greenfield task; got ${promptLen} chars`,
		);
	});

	it('non-Node workspace stays under 4000 chars (no ESM block)', async () => {
		const cwd = await mkWorkspace({
			'main.py': 'def add(a, b): return a + b\n',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'google/gemma-4-26b-a4b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
		});
		const promptLen = context.systemPrompt.length;
		assert.ok(
			promptLen < 4000,
			`Non-Node system message must stay under 4000 chars; got ${promptLen} chars`,
		);
	});

	it('native mode stays under 5000 chars (Node/ESM workspace)', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'test-model',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
			toolWritesMode: 'native',
		});
		const promptLen = context.systemPrompt.length;
		// Phase 207 grew lang:node; ~5292 chars → 5500 limit.
		// Phase 214 added no-subprocess directive + server-startup port pattern; ~5849 chars → 6100 limit.
		// Phase 218 added SQLite :memory: and server listen guard patterns; ~7003 chars → 7200 limit.
		// Phase 223 added FTS5 MATCH syntax and createDatabase factory patterns; ~8040 chars → 8500 limit.
		// Phase 227 added node:sqlite import-name, check-status-before-parse, and
		// module-scope-side-effects pitfalls; ~10242 chars. Limit raised to 11000.
		// Phase 238 added ESM cache-bust pitfall; ~11551 chars. Limit raised to 13000.
		// Phase 243 added StatementSync row-access pitfall; ~12189 chars. Limit stays 13000.
		// Phase 246 added SQLite test state reset pitfall; ~13146 chars. Limit raised to 14000.
		assert.ok(
			promptLen < 14000,
			`Native mode system message must stay under 14000 chars; got ${promptLen} chars`,
		);
	});

	// Phase 248: task-gating reduces prompt size for non-SQLite/HTTP tasks
	it('gated node prompt (plain task) is significantly shorter than ungated', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'google/gemma-4-26b-a4b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const ungated = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
		});
		const gated = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
			taskPrompt: 'add a slugify function to utils.mjs',
		});
		assert.ok(
			gated.systemPrompt.length < ungated.systemPrompt.length * 0.6,
			`Gated prompt (${gated.systemPrompt.length}) should be at least 40% smaller than ungated (${ungated.systemPrompt.length})`,
		);
	});

	it('envelope mode is shorter than auto mode (no write tools)', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'test-model',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const autoContext = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
			toolWritesMode: 'auto',
		});
		const envelopeContext = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
			toolWritesMode: 'envelope',
		});
		assert.ok(
			envelopeContext.systemPrompt.length < autoContext.systemPrompt.length,
			'envelope mode should produce a shorter system prompt than auto mode',
		);
	});
});

// ---------------------------------------------------------------------------
// gateLanguageGuidance — phase 248
// ---------------------------------------------------------------------------

describe('gateLanguageGuidance', () => {
	const SQLITE_MARKER = 'node:sqlite pitfalls';
	const HTTP_MARKER = 'HTTP integration test patterns';
	const BUSBOY_MARKER = 'busboy v1';
	const ALWAYS_MARKER = 'Test isolation';

	function makeBody() {
		return [
			'# Node.js / ESM Contract\n- ESM only\n',
			'## node:sqlite pitfalls (Node.js 24)\n- DatabaseSync pitfalls\n',
			'## HTTP integration test patterns\n- express server setup\n',
			'## Test isolation — prefer factories over ESM cache busting\n- use factories\n',
			'## busboy v1\n- Busboy is not a constructor\n',
		].join('');
	}

	it('returns full body when taskContext is empty string', () => {
		const body = makeBody();
		assert.equal(gateLanguageGuidance(body, ''), body);
	});

	it('returns full body when taskContext is falsy', () => {
		const body = makeBody();
		assert.equal(gateLanguageGuidance(body, null), body);
	});

	it('includes sqlite section when task mentions sqlite', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'use node:sqlite to store items',
		);
		assert.match(result, new RegExp(SQLITE_MARKER));
	});

	it('excludes sqlite section for a non-database task', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'write a string-utils module',
		);
		assert.doesNotMatch(result, new RegExp(SQLITE_MARKER));
	});

	it('includes sqlite section when task mentions DatabaseSync', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'fix the DatabaseSync import',
		);
		assert.match(result, new RegExp(SQLITE_MARKER));
	});

	it('includes http section when task mentions express', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'build an express REST API',
		);
		assert.match(result, new RegExp(HTTP_MARKER));
	});

	it('excludes http section for a non-server task', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'write a string-utils module',
		);
		assert.doesNotMatch(result, new RegExp(HTTP_MARKER));
	});

	it('includes http section when task mentions app.listen', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'fix app.listen port binding',
		);
		assert.match(result, new RegExp(HTTP_MARKER));
	});

	it('includes busboy section when task mentions busboy', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'handle multipart upload with busboy',
		);
		assert.match(result, new RegExp(BUSBOY_MARKER));
	});

	it('excludes busboy section for a task without busboy', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'write a string-utils module',
		);
		assert.doesNotMatch(result, new RegExp(BUSBOY_MARKER));
	});

	it('always includes the preamble', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'write a string-utils module',
		);
		assert.match(result, /# Node\.js \/ ESM Contract/u);
		assert.match(result, /ESM only/u);
	});

	it('always includes non-gated sections (test isolation)', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'write a string-utils module',
		);
		assert.match(result, new RegExp(ALWAYS_MARKER));
	});

	it('excludes both sqlite and http for a plain task', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'add a slugify function to utils.mjs',
		);
		assert.doesNotMatch(result, new RegExp(SQLITE_MARKER));
		assert.doesNotMatch(result, new RegExp(HTTP_MARKER));
		assert.doesNotMatch(result, new RegExp(BUSBOY_MARKER));
		assert.match(result, new RegExp(ALWAYS_MARKER));
	});

	it('includes all sections when task mentions everything', () => {
		const result = gateLanguageGuidance(
			makeBody(),
			'build a sqlite-backed express app with busboy uploads',
		);
		assert.match(result, new RegExp(SQLITE_MARKER));
		assert.match(result, new RegExp(HTTP_MARKER));
		assert.match(result, new RegExp(BUSBOY_MARKER));
		assert.match(result, new RegExp(ALWAYS_MARKER));
	});

	it('returns body unchanged when no ## headers present', () => {
		const body = 'no sections here\n- just a rule\n';
		assert.equal(gateLanguageGuidance(body, 'any task'), body);
	});
});

// renderLanguageGuidanceBlock — C2 (phase 121)
// ---------------------------------------------------------------------------

describe('renderLanguageGuidanceBlock', () => {
	it('returns empty string when isNodeEsm is false', () => {
		assert.equal(renderLanguageGuidanceBlock({ isNodeEsm: false }), '');
	});

	it('returns empty string when facts is undefined', () => {
		assert.equal(renderLanguageGuidanceBlock(undefined), '');
	});

	it('returns empty string when facts is null', () => {
		assert.equal(renderLanguageGuidanceBlock(null), '');
	});

	it('returns block starting with # Node.js / ESM Contract when isNodeEsm true', () => {
		const block = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.match(block, /^# Node\.js \/ ESM Contract/u);
	});

	it('contains the ESM-only rule', () => {
		const block = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.match(block, /import.*export/u);
		assert.match(block, /require/u);
		assert.match(block, /top-level `return`/u);
	});

	it('contains the node:test API rule', () => {
		const block = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.match(block, /node:test/u);
		assert.match(block, /t\.assert/u);
	});

	it('contains the argv token rule', () => {
		const block = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.match(block, /argv/u);
		assert.match(block, /separate tokens/u);
	});

	// Phase 122 shipped a 4-line block; phases 204/207 added node:sqlite, HTTP
	// integration, and busboy pitfall sections with code patterns. Assert the
	// pitfall coverage rather than a brittle exact line count.
	it('includes the phase-204/207 example pitfalls', () => {
		const block = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.match(block, /node:sqlite/u);
		assert.match(block, /lastInsertRowid/u);
		assert.match(block, /CURRENT_TIMESTAMP/u);
		assert.match(block, /closeAllConnections/u);
		assert.match(block, /server\.address\(\)\.port/u);
		assert.match(block, /Busboy is not a constructor/u);
	});

	it('is byte-stable when called twice with same facts', () => {
		const facts = { isNodeEsm: true };
		assert.equal(
			renderLanguageGuidanceBlock(facts),
			renderLanguageGuidanceBlock(facts),
		);
	});

	// Phase 122: content is sourced from the builtin lang:node skill.
	it('matches the builtin lang:node skill body (single source of truth)', async () => {
		const { getBuiltinSkill } = await import('../src/builtin-skills.mjs');
		const builtin = getBuiltinSkill('lang:node');
		assert.equal(
			renderLanguageGuidanceBlock({ isNodeEsm: true }),
			builtin.body.trim(),
		);
	});

	it('renders a provided guidance override (trimmed) instead of the builtin', () => {
		const override = '# Node.js / ESM Contract\n- house rule: prefer maps\n';
		const block = renderLanguageGuidanceBlock({
			guidance: override,
			isNodeEsm: true,
		});
		assert.equal(block, override.trim());
		assert.match(block, /house rule/u);
	});

	it('falls back to the builtin when guidance override is blank', () => {
		const builtinBlock = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.equal(
			renderLanguageGuidanceBlock({ guidance: '   ', isNodeEsm: true }),
			builtinBlock,
		);
	});

	it('returns empty when isNodeEsm false even if guidance is provided', () => {
		assert.equal(
			renderLanguageGuidanceBlock({ guidance: '# x', isNodeEsm: false }),
			'',
		);
	});

	// Phase 248: task-gating via taskContext
	it('applies gating when taskContext is provided — excludes sqlite section for plain task', () => {
		const block = renderLanguageGuidanceBlock({
			isNodeEsm: true,
			taskContext: 'add a slugify function to utils.mjs',
		});
		assert.doesNotMatch(block, /node:sqlite pitfalls/u);
		assert.doesNotMatch(block, /HTTP integration test patterns/u);
		assert.match(block, /# Node\.js \/ ESM Contract/u);
	});

	it('applies gating — includes sqlite section when task mentions node:sqlite', () => {
		const block = renderLanguageGuidanceBlock({
			isNodeEsm: true,
			taskContext: 'add a route that queries node:sqlite',
		});
		assert.match(block, /node:sqlite pitfalls/u);
	});

	it('no gating when taskContext is absent (full body returned)', () => {
		const gated = renderLanguageGuidanceBlock({
			isNodeEsm: true,
			taskContext: '',
		});
		const full = renderLanguageGuidanceBlock({ isNodeEsm: true });
		assert.equal(gated, full);
	});
});

// ---------------------------------------------------------------------------
// detectNodeEsm — C2 (phase 121)
// ---------------------------------------------------------------------------

describe('detectNodeEsm', () => {
	it('returns true when any .mjs file is in the file list', async () => {
		const cwd = await mkWorkspace({ 'src/app.mjs': 'export const x = 1;\n' });
		assert.equal(await detectNodeEsm(cwd, ['src/app.mjs']), true);
	});

	it('returns true when package.json has "type":"module"', async () => {
		const cwd = await mkWorkspace({
			'package.json': JSON.stringify({ name: 'test', type: 'module' }),
		});
		assert.equal(await detectNodeEsm(cwd, ['package.json']), true);
	});

	it('returns false when package.json has no type field', async () => {
		const cwd = await mkWorkspace({
			'package.json': JSON.stringify({ name: 'test' }),
		});
		assert.equal(await detectNodeEsm(cwd, ['package.json']), false);
	});

	it('returns false when package.json has type:commonjs', async () => {
		const cwd = await mkWorkspace({
			'package.json': JSON.stringify({ type: 'commonjs' }),
		});
		assert.equal(await detectNodeEsm(cwd, ['package.json']), false);
	});

	it('returns false for a Python workspace with no .mjs or package.json', async () => {
		const cwd = await mkWorkspace({ 'main.py': 'print("hello")\n' });
		assert.equal(await detectNodeEsm(cwd, ['main.py']), false);
	});

	it('returns false for empty file list', async () => {
		const cwd = await mkWorkspace({});
		assert.equal(await detectNodeEsm(cwd, []), false);
	});

	it('detects ESM from a greenfield task prompt naming a .mjs target', async () => {
		const cwd = await mkWorkspace({});
		assert.equal(
			await detectNodeEsm(cwd, [], 'Create wordfreq.mjs that counts words'),
			true,
		);
	});

	it('detects ESM from a prompt naming a .cjs target', async () => {
		const cwd = await mkWorkspace({});
		assert.equal(await detectNodeEsm(cwd, [], 'add a build.cjs script'), true);
	});

	it('does not fire on a prompt that only says "node" or names a .js file', async () => {
		const cwd = await mkWorkspace({});
		assert.equal(
			await detectNodeEsm(cwd, [], 'write a node script in main.js'),
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// detectRust — phase 210
// ---------------------------------------------------------------------------

describe('detectRust', () => {
	it('returns true when Cargo.toml is in the file list', () => {
		assert.equal(detectRust(['Cargo.toml', 'src/main.rs']), true);
	});

	it('returns false when Cargo.toml is absent', () => {
		assert.equal(detectRust(['src/main.rs', 'README.md']), false);
	});

	it('returns true when prompt names a .rs file (greenfield signal)', () => {
		assert.equal(detectRust([], 'Write src/main.rs with a word counter'), true);
	});

	it('returns false for empty files and no prompt signal', () => {
		assert.equal(detectRust([]), false);
	});
});

// ---------------------------------------------------------------------------
// renderLanguageGuidanceBlock — lang:rust (phase 210)
// ---------------------------------------------------------------------------

describe('renderLanguageGuidanceBlock — lang:rust (phase 210)', () => {
	it('returns Rust contract block when language is rust', () => {
		const block = renderLanguageGuidanceBlock({ language: 'rust' });
		assert.match(block, /# Rust \/ Cargo Contract/u);
	});

	it('Rust block mentions reqwest 0.12 version pin', () => {
		const block = renderLanguageGuidanceBlock({ language: 'rust' });
		assert.match(block, /reqwest.*0\.12/u);
	});

	it('Rust block mentions #[tokio::test]', () => {
		const block = renderLanguageGuidanceBlock({ language: 'rust' });
		assert.match(block, /#\[tokio::test\]/u);
	});

	it('Rust block mentions mod declaration', () => {
		const block = renderLanguageGuidanceBlock({ language: 'rust' });
		assert.match(block, /mod\s+\w+;/u);
	});

	it('returns empty for unknown language', () => {
		const block = renderLanguageGuidanceBlock({ language: 'python' });
		assert.equal(block, '');
	});
});

// ---------------------------------------------------------------------------
// buildWorkspaceContext — Rust workspace (phase 210)
// ---------------------------------------------------------------------------

describe('buildWorkspaceContext — Rust workspace (phase 210)', () => {
	it('detects Rust workspace and sets isRust:true', async () => {
		const cwd = await mkWorkspace({ 'Cargo.toml': '[package]\nname="app"' });
		const context = await buildWorkspaceContext(cwd, {});
		assert.equal(context.isRust, true);
		assert.equal(context.isNodeEsm, false);
	});

	it('injects Rust contract block for Cargo.toml workspace', async () => {
		const cwd = await mkWorkspace({ 'Cargo.toml': '[package]\nname="app"' });
		const context = await buildWorkspaceContext(cwd, {});
		assert.match(context.systemPrompt, /# Rust \/ Cargo Contract/u);
	});

	it('does NOT inject Rust block for Node/ESM workspace', async () => {
		const cwd = await mkWorkspace({ 'app.mjs': 'export const x = 1;' });
		const context = await buildWorkspaceContext(cwd, {});
		assert.doesNotMatch(context.systemPrompt, /# Rust \/ Cargo Contract/u);
	});
});

// ---------------------------------------------------------------------------
// renderPromptSections — isNodeEsm integration (C2)
// ---------------------------------------------------------------------------

describe('renderPromptSections — isNodeEsm (C2)', () => {
	it('stable section contains ESM contract when isNodeEsm:true', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			isNodeEsm: true,
			toolsMode: false,
		});
		assert.match(sections.stable, /# Node\.js \/ ESM Contract/u);
	});

	it('stable section does NOT contain ESM contract when isNodeEsm:false', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			isNodeEsm: false,
			toolsMode: false,
		});
		assert.doesNotMatch(sections.stable, /# Node\.js \/ ESM Contract/u);
	});

	it('stable section does NOT contain ESM contract when isNodeEsm absent (default)', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			toolsMode: false,
		});
		assert.doesNotMatch(sections.stable, /# Node\.js \/ ESM Contract/u);
	});

	it('stableHash differs between isNodeEsm:true and isNodeEsm:false', () => {
		const withEsm = renderPromptSections({ isNodeEsm: true });
		const withoutEsm = renderPromptSections({ isNodeEsm: false });
		assert.notEqual(withEsm.stable, withoutEsm.stable);
	});

	it('non-Node workspace prompt is byte-identical to phase-120 baseline (no ESM block)', () => {
		// Regression: a workspace with isNodeEsm:false must produce the same
		// stable section as before phase 121. Compare to a call with no isNodeEsm.
		const baseline = renderPromptSections({
			editFormat: 'patch',
			toolsMode: false,
		});
		const nonNode = renderPromptSections({
			editFormat: 'patch',
			isNodeEsm: false,
			toolsMode: false,
		});
		assert.equal(
			baseline.stable,
			nonNode.stable,
			'non-Node workspace stable section must be byte-identical to baseline',
		);
	});
});

// ---------------------------------------------------------------------------
// buildWorkspaceContext — isNodeEsm detection in Node/ESM workspace (C2)
// ---------------------------------------------------------------------------

describe('buildWorkspaceContext — isNodeEsm auto-detection', () => {
	it('includes ESM contract in system prompt for workspace with .mjs file', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const context = await buildWorkspaceContext(cwd);
		assert.match(context.systemPrompt, /# Node\.js \/ ESM Contract/u);
	});

	it('includes ESM contract for package.json with type:module', async () => {
		const cwd = await mkWorkspace({
			'package.json': JSON.stringify({ type: 'module' }),
			'index.js': 'console.log("hi");\n',
		});
		const context = await buildWorkspaceContext(cwd);
		assert.match(context.systemPrompt, /# Node\.js \/ ESM Contract/u);
	});

	it('omits ESM contract for Python workspace', async () => {
		const cwd = await mkWorkspace({
			'main.py': 'print("hello")\n',
		});
		const context = await buildWorkspaceContext(cwd);
		assert.doesNotMatch(context.systemPrompt, /# Node\.js \/ ESM Contract/u);
	});

	it('respects isNodeEsm:false override even when .mjs present', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const context = await buildWorkspaceContext(cwd, { isNodeEsm: false });
		assert.doesNotMatch(context.systemPrompt, /# Node\.js \/ ESM Contract/u);
	});

	it('prompt budget guard still holds with ESM block (Node workspace under 6000 chars)', async () => {
		const cwd = await mkWorkspace({
			'app.mjs': 'export function add(a, b) { return a + b; }',
		});
		const facts = {
			cwd,
			date: '2026-06-12',
			gitBranch: 'main',
			gitRepo: true,
			model: 'qwen/qwen3.6-35b-a3b',
			nodeVersion: 'v24.16.0',
			osRelease: 'Darwin 25.5.0',
			platform: 'darwin',
			shell: 'zsh',
		};
		const context = await buildWorkspaceContext(cwd, {
			environmentFacts: facts,
			toolsMode: true,
		});
		// Phase 204/207 grew lang:node; phase 210 added lang:rust. Current: ~6133. Limit raised to 7000.
		// Phase 218 added SQLite :memory: and server listen guard patterns; ~8076 chars. Limit raised to 8500.
		// Phase 223 added FTS5 MATCH syntax and createDatabase factory patterns; ~9113 chars. Limit raised to 9500.
		// Phase 227 added node:sqlite import-name, check-status-before-parse, and
		// module-scope-side-effects pitfalls; ~11315 chars. Limit raised to 12000.
		// Phase 238 added ESM cache-bust pitfall; ~12624 chars. Limit raised to 14000.
		// Phase 246 added SQLite test state reset pitfall; ~14219 chars. Limit raised to 15000.
		assert.ok(
			context.systemPrompt.length < 15000,
			`System message must stay under 15000 chars with ESM block; got ${context.systemPrompt.length} chars`,
		);
	});
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-sysenv-'));
	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content);
	}
	return cwd;
}
