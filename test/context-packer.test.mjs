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

describe('context packing', () => {
	it('walks files deterministically and ignores generated directories', async () => {
		const cwd = await mkWorkspace({
			'.kodr/hidden.txt': 'hidden',
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
