import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildWorkspaceContext,
	listContextFiles,
	renderContextMarkdown,
} from '../src/context-packer.mjs';
import { inspectWorkspace } from '../src/code-inspector.mjs';

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
		assert.match(context.systemPrompt, /<workspace-instructions/u);
		assert.match(context.systemPrompt, /Always prefer small commits/u);
		assert.deepEqual(
			context.files.map((file) => file.path),
			['index.js'],
		);
		assert.doesNotMatch(renderContextMarkdown(context), /binary/u);
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

async function mkWorkspace(files) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-context-'));

	for (const [path, content] of Object.entries(files)) {
		const absolute = join(cwd, path);
		await mkdir(join(absolute, '..'), { recursive: true });
		await writeFile(absolute, content);
	}

	return cwd;
}
