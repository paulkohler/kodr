import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function buildSite(options = {}) {
	const cwd = options.cwd || process.cwd();
	const postsDir = options.postsDir || join(cwd, 'posts');
	const outDir = options.outDir || join(cwd, 'dist');
	const posts = await loadPosts(postsDir);

	await mkdir(outDir, { recursive: true });
	for (const post of posts) {
		await writeFile(join(outDir, post.output), renderPostPage(post), 'utf8');
	}
	await writeFile(join(outDir, 'index.html'), renderIndex(posts), 'utf8');

	return {
		outDir,
		postCount: posts.length,
		posts,
	};
}

export async function loadPosts(postsDir) {
	const entries = await readdir(postsDir, { withFileTypes: true });
	const posts = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) {
			continue;
		}

		const path = join(postsDir, entry.name);
		const source = await readFile(path, 'utf8');
		posts.push(parsePost(source, entry.name));
	}

	return posts.sort((left, right) => right.date.localeCompare(left.date));
}

export function parsePost(source, filename = 'post.md') {
	const { body, frontmatter } = parseFrontmatter(source);
	const slug = filename.replace(/\.md$/u, '');
	const title = frontmatter.title || titleFromSlug(slug);

	return {
		date: frontmatter.date || '',
		description: frontmatter.description || '',
		html: renderMarkdown(body),
		output: `${slug}.html`,
		slug,
		title,
	};
}

export function renderMarkdown(source) {
	const lines = source.replaceAll('\r\n', '\n').split('\n');
	const blocks = [];
	let paragraph = [];
	let code = null;

	for (const line of lines) {
		if (line.startsWith('```')) {
			if (code) {
				blocks.push(
					`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`,
				);
				code = null;
			} else {
				flushParagraph(blocks, paragraph);
				paragraph = [];
				code = { lines: [] };
			}
			continue;
		}

		if (code) {
			code.lines.push(line);
			continue;
		}

		if (!line.trim()) {
			flushParagraph(blocks, paragraph);
			paragraph = [];
			continue;
		}

		const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
		if (heading) {
			flushParagraph(blocks, paragraph);
			paragraph = [];
			const level = heading[1].length;
			blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
			continue;
		}

		paragraph.push(line.trim());
	}

	if (code) {
		blocks.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
	}
	flushParagraph(blocks, paragraph);

	return `${blocks.join('\n')}\n`;
}

export function renderIndex(posts) {
	const items = posts
		.map((post) => {
			const description = post.description
				? `<p>${escapeHtml(post.description)}</p>`
				: '';
			return `<li><a href="./${escapeAttribute(post.output)}">${escapeHtml(post.title)}</a><time datetime="${escapeAttribute(post.date)}">${escapeHtml(post.date)}</time>${description}</li>`;
		})
		.join('\n');

	return page('Blog', `<h1>Blog</h1>\n<ul>\n${items}\n</ul>`);
}

export function renderPostPage(post) {
	const description = post.description
		? `<p>${escapeHtml(post.description)}</p>`
		: '';
	return page(
		post.title,
		`<article>\n<h1>${escapeHtml(post.title)}</h1>\n<time datetime="${escapeAttribute(post.date)}">${escapeHtml(post.date)}</time>\n${description}\n${post.html}</article>`,
	);
}

function parseFrontmatter(source) {
	if (!source.startsWith('---\n')) {
		return {
			body: source,
			frontmatter: {},
		};
	}

	const end = source.indexOf('\n---', 4);
	if (end === -1) {
		return {
			body: source,
			frontmatter: {},
		};
	}

	const frontmatter = {};
	for (const line of source.slice(4, end).split('\n')) {
		const separator = line.indexOf(':');
		if (separator === -1) {
			continue;
		}
		frontmatter[line.slice(0, separator).trim()] = line
			.slice(separator + 1)
			.trim();
	}

	return {
		body: source.slice(end + 4).replace(/^\n/u, ''),
		frontmatter,
	};
}

function flushParagraph(blocks, paragraph) {
	if (paragraph.length > 0) {
		blocks.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
	}
}

function renderInline(source) {
	const codeParts = source.split(/(`[^`]+`)/u);
	return codeParts
		.map((part) => {
			if (part.startsWith('`') && part.endsWith('`')) {
				return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
			}

			return renderInlineText(part);
		})
		.join('');
}

function renderInlineText(source) {
	let html = escapeHtml(source);
	html = html.replaceAll(
		/\[([^\]]+)\]\(([^)\s]+)\)/gu,
		(_, text, href) =>
			`<a href="${escapeAttribute(safeHref(href))}">${text}</a>`,
	);
	html = html.replaceAll(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>');
	html = html.replaceAll(/\*([^*]+)\*/gu, '<em>$1</em>');
	return html;
}

function safeHref(href) {
	if (
		href.startsWith('http://') ||
		href.startsWith('https://') ||
		href.startsWith('./') ||
		href.startsWith('/') ||
		href.startsWith('#')
	) {
		return href;
	}

	return '#';
}

function page(title, body) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>
`;
}

function titleFromSlug(slug) {
	return basename(slug)
		.split('-')
		.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
		.join(' ');
}

function escapeHtml(value) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
	return escapeHtml(value);
}
