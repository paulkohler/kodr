import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildSite, parsePost, renderMarkdown } from '../src/blog.mjs';

describe('markdown blog generator', () => {
	it('parses frontmatter and renders markdown features', () => {
		const post = parsePost(
			`---
title: Hello <World>
date: 2026-05-26
description: Test post
---

# Heading

A **bold** and *em* paragraph with \`code\` and [link](./x.html).

\`\`\`
<script>
\`\`\`
`,
			'hello-world.md',
		);

		assert.equal(post.title, 'Hello <World>');
		assert.equal(post.date, '2026-05-26');
		assert.equal(post.output, 'hello-world.html');
		assert.match(post.html, /<h1>Heading<\/h1>/u);
		assert.match(post.html, /<strong>bold<\/strong>/u);
		assert.match(post.html, /<em>em<\/em>/u);
		assert.match(post.html, /<code>code<\/code>/u);
		assert.match(post.html, /<a href="\.\/x\.html">link<\/a>/u);
		assert.match(post.html, /&lt;script&gt;/u);
	});

	it('escapes unsafe html and unsafe links', () => {
		const html = renderMarkdown(
			'# <script>\n\n[bad](javascript:alert(1)) <img src=x>',
		);

		assert.match(html, /&lt;script&gt;/u);
		assert.match(html, /href="#"/u);
		assert.match(html, /&lt;img src=x&gt;/u);
	});

	it('builds posts and index sorted by date descending', async (t) => {
		const cwd = await mkdtemp(join(tmpdir(), 'markdown-blog-'));
		t.after(() => rm(cwd, { force: true, recursive: true }));
		await mkdir(join(cwd, 'posts'), { recursive: true });
		await writeFile(
			join(cwd, 'posts', 'old.md'),
			'---\ntitle: Old\ndate: 2026-01-01\n---\n\n# Old',
			'utf8',
		);
		await writeFile(
			join(cwd, 'posts', 'new.md'),
			'---\ntitle: New\ndate: 2026-02-01\n---\n\n# New',
			'utf8',
		);

		const result = await buildSite({ cwd });
		const index = await readFile(join(cwd, 'dist', 'index.html'), 'utf8');

		assert.equal(result.postCount, 2);
		assert.ok(index.indexOf('New') < index.indexOf('Old'));
		assert.match(
			await readFile(join(cwd, 'dist', 'new.html'), 'utf8'),
			/<h1>New<\/h1>/u,
		);
	});
});
