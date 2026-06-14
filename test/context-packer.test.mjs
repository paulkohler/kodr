import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildWorkspaceContext,
	detectModelFamily,
	listContextFiles,
	planContextBudget,
	renderContextMarkdown,
	renderPromptSections,
} from '../src/context-packer.mjs';
import { renderEditFormatContract } from '../src/edit-formats.mjs';
import {
	inspectWorkspace,
	selectInspectionChunks,
} from '../src/repomap/index.mjs';

describe('context packing', () => {
	it('walks files deterministically and ignores generated directories', async () => {
		const cwd = await mkWorkspace({
			'.kodr/hidden.txt': 'hidden',
			'.kodr-nemotron-test2/error.json': '{}',
			'.kodr-repair-1/context.md': 'old context',
			'a.txt': 'a',
			'b.txt': 'b',
			'node_modules/pkg/index.js': 'ignored',
			'src/app.mjs': 'export {};',
		});

		assert.deepEqual(await listContextFiles(cwd), [
			'a.txt',
			'b.txt',
			'src/app.mjs',
		]);
	});

	it('filters binary files and includes AGENTS.md as instruction context', async () => {
		const cwd = await mkWorkspace({
			'AGENTS.md': 'Always prefer small commits.',
			'binary.dat': Buffer.from([0, 1, 2, 3]),
			'index.js': 'console.log("ok");',
		});

		const context = await buildWorkspaceContext(cwd);

		assert.equal(context.agents.path, 'AGENTS.md');
		assert.match(
			context.systemPrompt,
			/Repository instructions from AGENTS\.md/u,
		);
		assert.match(context.systemPrompt, /"status":"OK"/u);
		assert.match(context.systemPrompt, /"messages"/u);
		assert.match(context.systemPrompt, /Use status "ERROR"/u);
		// inspect_symbols and find_references are in the # Tools block, which is
		// only present in tools mode (toolsMode: true). Non-tools mode has behaviours
		// but not the tools section.
		assert.doesNotMatch(context.systemPrompt, /inspect_symbols/u);
		assert.match(context.systemPrompt, /# Behaviours/u);
		assert.match(context.systemPrompt, /<workspace-instructions/u);
		assert.match(context.systemPrompt, /Always prefer small commits/u);
		assert.match(context.promptSections.stable, /You are Kodr/u);
		assert.match(context.promptSections.stable, /# Behaviours/u);
		assert.match(
			context.promptSections.project,
			/Always prefer small commits/u,
		);
		assert.doesNotMatch(context.promptSections.stable, /Always prefer/u);
		assert.deepEqual(
			context.files.map((file) => file.path),
			['index.js'],
		);
		assert.doesNotMatch(renderContextMarkdown(context), /binary/u);
	});

	it('keeps stable and project prompt hashes stable across source changes', async () => {
		const cwd = await mkWorkspace({
			'AGENTS.md': 'Always prefer small commits.',
			'src/app.mjs': 'export const value = 1;',
		});
		const before = await buildWorkspaceContext(cwd);
		await writeFile(join(cwd, 'src/app.mjs'), 'export const value = 2;');
		const after = await buildWorkspaceContext(cwd);

		assert.equal(before.promptPrefix.stableHash, after.promptPrefix.stableHash);
		assert.equal(
			before.promptPrefix.projectHash,
			after.promptPrefix.projectHash,
		);
		assert.notEqual(
			before.promptPrefix.volatileHash,
			after.promptPrefix.volatileHash,
		);
	});

	it('moves AGENTS.md changes into the project prompt hash', async () => {
		const cwd = await mkWorkspace({
			'AGENTS.md': 'Always prefer small commits.',
			'src/app.mjs': 'export const value = 1;',
		});
		const before = await buildWorkspaceContext(cwd);
		await writeFile(cwd + '/AGENTS.md', 'Always run tests.');
		const after = await buildWorkspaceContext(cwd);

		assert.equal(before.promptPrefix.stableHash, after.promptPrefix.stableHash);
		assert.notEqual(
			before.promptPrefix.projectHash,
			after.promptPrefix.projectHash,
		);
	});

	it('moves loaded skill changes into the semi-stable prompt hash', () => {
		const base = renderPromptSections({
			files: [],
			memory: { project: null, user: null },
			skills: {
				index: [],
				loaded: [
					{ body: 'Use the first rule.', name: 'demo', path: 'skills/demo' },
				],
			},
		});
		const changed = renderPromptSections({
			files: [],
			memory: { project: null, user: null },
			skills: {
				index: [],
				loaded: [
					{ body: 'Use the second rule.', name: 'demo', path: 'skills/demo' },
				],
			},
		});

		assert.equal(base.stable, changed.stable);
		assert.notEqual(base.semiStable, changed.semiStable);
	});

	it('lists package locks without packing their contents by default', async () => {
		const cwd = await mkWorkspace({
			'package-lock.json': '{"packages":{"node_modules/express":{}}}',
			'package.json': '{"dependencies":{"express":"^5.1.0"}}',
			'src/app.mjs': 'export function createApp() {}',
		});

		const files = await listContextFiles(cwd);
		const context = await buildWorkspaceContext(cwd);
		const markdown = renderContextMarkdown(context);

		assert.deepEqual(files, [
			'package-lock.json',
			'package.json',
			'src/app.mjs',
		]);
		assert.deepEqual(
			context.files.map((file) => file.path),
			['package.json', 'src/app.mjs'],
		);
		assert.deepEqual(context.omittedFiles, [
			{
				path: 'package-lock.json',
				reason: 'lockfile listed but not packed by default',
			},
		]);
		assert.match(markdown, /Listed but not packed/u);
		assert.match(markdown, /package-lock\.json/u);
		assert.doesNotMatch(markdown, /node_modules\/express/u);
	});

	it('lists package locks in tools-mode file maps for explicit reads', async () => {
		const cwd = await mkWorkspace({
			'package-lock.json': '{"lockfileVersion":3}',
			'package.json': '{}',
		});

		const context = await buildWorkspaceContext(cwd, { toolsMode: true });

		assert.equal(
			context.fileMap.entries.some(
				(entry) => entry.path === 'package-lock.json',
			),
			true,
		);
		assert.deepEqual(context.files, []);
		assert.match(context.systemPrompt, /package-lock\.json/u);
		assert.doesNotMatch(context.systemPrompt, /lockfileVersion/u);
	});

	it('F7: fileMap.total reflects the workspace file count in tools mode', async () => {
		const cwd = await mkWorkspace({
			'a.mjs': 'export const a = 1;',
			'b.mjs': 'export const b = 2;',
			'src/c.mjs': 'export const c = 3;',
		});

		const context = await buildWorkspaceContext(cwd, { toolsMode: true });

		// In tools mode, files is empty but fileMap.total holds the count.
		assert.deepEqual(context.files, []);
		assert.equal(
			context.fileMap.total,
			3,
			'fileMap.total should count all workspace files',
		);
	});

	it('renders memory scopes without listing private memory as a workspace file', async () => {
		const cwd = await mkWorkspace({
			'.kodr/memory/user.md': 'Use concise replies.',
			'KODR_MEMORY.md': 'Project prefers patches.',
			'src/app.mjs': 'export {};',
		});

		const context = await buildWorkspaceContext(cwd, {
			memory: {
				project: {
					content: 'Project prefers patches.',
					includedBytes: 24,
					path: 'KODR_MEMORY.md',
					truncated: false,
				},
				user: {
					content: 'Use concise replies.',
					includedBytes: 20,
					path: '.kodr/memory/user.md',
					truncated: false,
				},
			},
		});

		assert.deepEqual(await listContextFiles(cwd), [
			'KODR_MEMORY.md',
			'src/app.mjs',
		]);
		assert.deepEqual(
			context.files.map((file) => file.path),
			['src/app.mjs'],
		);
		assert.match(context.systemPrompt, /Project memory/u);
		assert.match(context.systemPrompt, /Private user memory/u);
		assert.match(renderContextMarkdown(context), /<project-memory/u);
		assert.match(renderContextMarkdown(context), /<private-user-memory/u);
	});

	it('packs inspection-aware chunks around matching symbols and related tests', async () => {
		const cwd = await mkWorkspace({
			'src/app.mjs': [
				"import { helper } from './helper.mjs';",
				'',
				'export function runPrompt(value) {',
				'  return helper(value);',
				'}',
				'',
				'export function unrelated() {',
				'  return 1;',
				'}',
			].join('\n'),
			'test/app.test.mjs': [
				"import { runPrompt } from '../src/app.mjs';",
				'',
				"test('runPrompt returns helper output', () => {",
				"  assert.equal(runPrompt('x'), 'x');",
				'});',
			].join('\n'),
		});
		const index = await inspectWorkspace(cwd);

		const context = await buildWorkspaceContext(cwd, {
			inspection: {
				enabled: true,
				index,
				query: 'Change runPrompt to validate input',
			},
		});

		assert.equal(context.inspection.mode, 'inspection-aware');
		assert.equal(context.inspection.selectedSymbolCount, 2);
		assert.equal(
			context.files.some((file) => file.path.includes('#runPrompt')),
			true,
		);
		assert.equal(
			context.files.some((file) => file.metadata?.kind === 'related-test'),
			true,
		);
		assert.doesNotMatch(
			context.files.map((file) => file.content).join('\n'),
			/export function unrelated/u,
		);
		assert.match(renderContextMarkdown(context), /Inspection context/u);
		assert.match(context.systemPrompt, /Selected code chunks/u);
	});

	it('packs ranked inspection matches before lower-scoring matches', async () => {
		const cwd = await mkWorkspace({
			'src/app.mjs': [
				'export function targetHigh() {',
				'  return 1;',
				'}',
				'targetHigh();',
				'targetHigh();',
				'',
				'export function targetLow() {',
				'  return 2;',
				'}',
			].join('\n'),
		});
		const index = await inspectWorkspace(cwd);

		const context = await buildWorkspaceContext(cwd, {
			inspection: {
				enabled: true,
				index,
				query: 'change target function',
			},
		});

		assert.equal(context.inspection.rankedSymbolCount, 2);
		assert.equal(context.files[0].metadata.name, 'targetHigh');
		assert.equal(context.files[0].metadata.kind, 'symbol');
	});

	it('plans context budgets deterministically from window and reserve', () => {
		assert.deepEqual(
			planContextBudget({
				completionReserve: 100,
				contextWindow: 1000,
				totalBytes: 10000,
			}),
			{
				budgetChars: 3600,
				budgetTokens: 900,
				completionReserve: 100,
				contextWindow: 1000,
				droppedChars: 0,
				droppedChunks: 0,
				estimatedCharsPerToken: 4,
				packedChars: 0,
				requestedChars: 10000,
			},
		);
	});

	it('selects inspection chunks without exceeding the byte budget', () => {
		const result = selectInspectionChunks(
			[
				{ content: 'aaaa', path: 'a' },
				{ content: 'bbbb', path: 'b' },
				{ content: 'cccc', path: 'c' },
			],
			8,
		);

		assert.deepEqual(
			result.chunks.map((chunk) => chunk.path),
			['a', 'b'],
		);
		assert.equal(result.usedChars, 8);
		assert.equal(result.droppedChunks, 1);
		assert.equal(result.droppedChars, 4);
	});

	it('truncates the first inspection chunk rather than exceeding tiny budgets', () => {
		const result = selectInspectionChunks(
			[{ content: 'abcdefghij', path: 'a' }],
			4,
		);

		assert.equal(result.chunks[0].content, 'abcd');
		assert.equal(result.chunks[0].truncated, true);
		assert.equal(result.usedChars, 4);
		assert.equal(result.droppedChars, 6);
	});

	it('reports dropped inspection chunks when the context budget is small', async () => {
		const cwd = await mkWorkspace({
			'src/app.mjs': [
				'export function targetOne() {',
				'  return "one";',
				'}',
				'',
				'export function targetTwo() {',
				'  return targetOne();',
				'}',
				'',
				'export function targetThree() {',
				'  return targetTwo();',
				'}',
			].join('\n'),
		});
		const index = await inspectWorkspace(cwd);

		const context = await buildWorkspaceContext(cwd, {
			completionReserve: 10,
			contextWindow: 20,
			inspection: {
				enabled: true,
				index,
				query: 'target',
			},
			totalBytes: 40,
		});

		assert.ok(context.totalBytes <= context.contextBudget.budgetChars);
		assert.ok(context.inspection.droppedChunks > 0);
		assert.match(renderContextMarkdown(context), /Dropped chunks: [1-9]/u);
	});

	it('falls back to file summaries when inspection finds no matching symbols', async () => {
		const cwd = await mkWorkspace({
			'src/app.py': [
				'import json',
				'',
				'def parse_payload(value):',
				'    return json.loads(value)',
			].join('\n'),
		});
		const index = await inspectWorkspace(cwd);

		const context = await buildWorkspaceContext(cwd, {
			inspection: {
				enabled: true,
				index,
				query: 'Update missing symbol',
			},
		});

		assert.deepEqual(context.files, []);
		assert.equal(context.inspection.fileSummaries[0].path, 'src/app.py');
		assert.match(
			renderContextMarkdown(context),
			/No symbol-specific chunks selected/u,
		);
	});
});

// ---------------------------------------------------------------------------
// D1 (phase 119): per-mode byte-identity coupling between edit-formats.mjs and
// context-packer.mjs. Both must produce byte-identical contract text per mode.
// ---------------------------------------------------------------------------

describe('D1 (phase 119): per-mode contract coupling (edit-formats ↔ context-packer)', () => {
	// 'patch' mode with auto toolWritesMode — should match the stable section from context-packer.
	it('native mode: renderPromptSections stable section contains tool-first contract', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			toolWritesMode: 'native',
		});
		// Native mode: tool-first wording, no envelope schema.
		assert.ok(
			sections.stable.includes('write_file') ||
				sections.stable.includes('edit_file'),
		);
		assert.ok(!sections.stable.includes('"status"'));
		assert.ok(!sections.stable.includes('"files"'));
	});

	it('envelope mode: renderPromptSections stable section contains envelope schema', () => {
		const sections = renderPromptSections({
			editFormat: 'patch',
			toolWritesMode: 'envelope',
		});
		assert.ok(sections.stable.includes('"status"'));
		assert.ok(sections.stable.includes('"files"'));
	});

	it('auto mode: byte-identical to envelope mode for stable section (regression)', () => {
		const auto = renderPromptSections({
			editFormat: 'patch',
			toolWritesMode: 'auto',
		});
		const envelope = renderPromptSections({
			editFormat: 'patch',
			toolWritesMode: 'envelope',
		});
		assert.equal(auto.stable, envelope.stable);
	});

	it('native mode: renderEditFormatContract byte-matches what context-packer uses in native mode', () => {
		// The canonical native contract from edit-formats.mjs must equal what
		// renderStableSection (via renderKodrBaseContract) produces in native mode.
		const canonicalNative = renderEditFormatContract('patch', 'native');
		const sections = renderPromptSections({
			editFormat: 'patch',
			toolWritesMode: 'native',
		});
		// The stable section starts with the contract, so check it starts with canonical.
		assert.ok(sections.stable.startsWith(canonicalNative));
	});

	it('envelope mode: renderEditFormatContract byte-matches what context-packer uses in envelope mode', () => {
		const canonicalEnvelope = renderEditFormatContract('patch', 'envelope');
		const sections = renderPromptSections({
			editFormat: 'patch',
			toolWritesMode: 'envelope',
		});
		assert.ok(sections.stable.startsWith(canonicalEnvelope));
	});

	it('D4: native-mode system prompt is meaningfully shorter than envelope-mode system prompt', async () => {
		const cwd = await mkWorkspace({
			'src/app.mjs': 'export const x = 1;',
		});
		const nativeContext = await buildWorkspaceContext(cwd, {
			toolsMode: true,
			toolWritesMode: 'native',
		});
		const envelopeContext = await buildWorkspaceContext(cwd, {
			toolsMode: true,
			toolWritesMode: 'envelope',
		});
		const nativeLen = (nativeContext.systemPrompt || '').length;
		const envelopeLen = (envelopeContext.systemPrompt || '').length;
		// Native mode drops the ~600-char envelope schema paragraph.
		// Assert at least 400 chars shorter (conservative to avoid flakiness).
		assert.ok(
			envelopeLen - nativeLen >= 400,
			`Expected native prompt to be at least 400 chars shorter than envelope; got native=${nativeLen}, envelope=${envelopeLen}, delta=${envelopeLen - nativeLen}`,
		);
	});
});

describe('language guidance (phase 122)', () => {
	it('applies the builtin lang:node block for a Node/ESM workspace', async () => {
		const cwd = await mkWorkspace({ 'index.mjs': 'export {};' });
		const context = await buildWorkspaceContext(cwd, { toolsMode: true });
		assert.match(context.systemPrompt, /# Node\.js \/ ESM Contract/u);
		assert.equal(context.languageGuidance.language, 'node');
		assert.equal(context.languageGuidance.source, 'builtin');
	});

	it('lets a workspace lang:node skill override the builtin guidance', async () => {
		const cwd = await mkWorkspace({
			'index.mjs': 'export {};',
			'house-skill/SKILL.md': [
				'---',
				'name: lang:node',
				'description: house override',
				'---',
				'# Node.js / ESM Contract',
				'- HOUSE RULE: prefer Map over plain objects for lookups',
				'',
			].join('\n'),
		});
		const context = await buildWorkspaceContext(cwd, { toolsMode: true });
		assert.match(context.systemPrompt, /HOUSE RULE/u);
		assert.equal(context.languageGuidance.source, 'override');
	});

	it('emits no language guidance for a non-Node workspace', async () => {
		const cwd = await mkWorkspace({ 'main.py': 'print(1)' });
		const context = await buildWorkspaceContext(cwd, { toolsMode: true });
		assert.doesNotMatch(context.systemPrompt, /# Node\.js \/ ESM Contract/u);
		assert.equal(context.languageGuidance, null);
	});

	// Phase 124: --no-language-guidance (suppressLanguageGuidance) forces the
	// block off even for a Node/ESM workspace — the A-arm of the A/B.
	it('suppresses the block when suppressLanguageGuidance is set', async () => {
		const cwd = await mkWorkspace({ 'index.mjs': 'export {};' });
		const on = await buildWorkspaceContext(cwd, { toolsMode: true });
		const off = await buildWorkspaceContext(cwd, {
			suppressLanguageGuidance: true,
			toolsMode: true,
		});
		assert.match(on.systemPrompt, /# Node\.js \/ ESM Contract/u);
		assert.doesNotMatch(off.systemPrompt, /# Node\.js \/ ESM Contract/u);
		assert.equal(off.languageGuidance, null);
	});
});

describe('model-family guidance (phase 143)', () => {
	it('detectModelFamily recognises devstral', () => {
		assert.equal(
			detectModelFamily('mistralai/devstral-small-2-2512'),
			'devstral',
		);
		assert.equal(detectModelFamily('devstral'), 'devstral');
		assert.equal(detectModelFamily('Devstral-Large'), 'devstral');
	});

	it('detectModelFamily recognises gpt-oss', () => {
		assert.equal(detectModelFamily('openai/gpt-oss-20b'), 'gpt-oss');
		assert.equal(detectModelFamily('gpt-oss'), 'gpt-oss');
	});

	it('detectModelFamily returns null for unknown models', () => {
		assert.equal(detectModelFamily('qwen/qwen3.6-35b-a3b'), null);
		assert.equal(detectModelFamily(''), null);
		assert.equal(detectModelFamily(null), null);
	});

	it('injects model:devstral guidance when model is devstral', async () => {
		const cwd = await mkWorkspace({ 'main.py': 'print(1)' });
		const context = await buildWorkspaceContext(cwd, {
			toolsMode: true,
			model: 'mistralai/devstral-small-2-2512',
		});
		assert.match(context.systemPrompt, /# Devstral Contract/u);
		assert.equal(context.modelGuidance?.family, 'devstral');
		assert.equal(context.modelGuidance?.source, 'builtin');
	});

	it('does not inject model guidance for unknown model', async () => {
		const cwd = await mkWorkspace({ 'main.py': 'print(1)' });
		const context = await buildWorkspaceContext(cwd, {
			toolsMode: true,
			model: 'qwen/qwen3.6-35b-a3b',
		});
		assert.doesNotMatch(context.systemPrompt, /# Devstral Contract/u);
		assert.equal(context.modelGuidance, null);
	});

	it('phase 145: suppressModelGuidance suppresses the model-family block', async () => {
		const cwd = await mkWorkspace({ 'main.py': 'print(1)' });
		const context = await buildWorkspaceContext(cwd, {
			toolsMode: true,
			model: 'mistralai/devstral-small-2-2512',
			suppressModelGuidance: true,
		});
		assert.doesNotMatch(context.systemPrompt, /# Devstral Contract/u);
		assert.equal(context.modelGuidance, null);
	});

	it('lets a workspace model:devstral skill override the builtin guidance', async () => {
		const cwd = await mkWorkspace({
			'main.py': 'print(1)',
			'house-skill/SKILL.md': [
				'---',
				'name: model:devstral',
				'description: house devstral override',
				'---',
				'# Devstral Contract',
				'- HOUSE RULE: always add type annotations.',
				'',
			].join('\n'),
		});
		const context = await buildWorkspaceContext(cwd, {
			toolsMode: true,
			model: 'mistralai/devstral-small-2-2512',
		});
		assert.match(context.systemPrompt, /HOUSE RULE/u);
		assert.equal(context.modelGuidance?.source, 'override');
	});
});

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-context-'));

	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content);
	}

	return cwd;
}
