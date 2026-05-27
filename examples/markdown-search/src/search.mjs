import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Recursively reads all .md files under root, sorted deterministically.
 * @param {string} root - directory path.
 * @returns {Promise<Map<string, string>>} Map of filePath -> fileContent.
 */
export async function readMarkdownFiles(root) {
	const files = new Set();
	const stack = [root];
	const visited = new Set();

	while (stack.length) {
		const dir = stack.pop();
		if (visited.has(dir)) continue;
		visited.add(dir);

		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
			} else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
				files.add(fullPath);
			}
		}
	}

	// Deterministic ordering
	const sortedFiles = Array.from(files).sort();
	const map = new Map();
	for (const file of sortedFiles) {
		const content = await readFile(file, 'utf8');
		map.set(file, content);
	}
	return map;
}

/**
 * Parses a markdown document.
 * @param {string} path - file path.
 * @param {string} content - markdown text.
 * @returns {{title: string, headings: string[], body: string}} parsed components.
 */
export function parseMarkdownDocument(path, content) {
	let title = '';
	let headings = [];
	let body = content;

	// Detect frontmatter
	const frontmatterMatch = content.match(/^---(\n)?([\s\S]*?)\n---/);
	let remaining = content;
	if (frontmatterMatch) {
		const fmLines = frontmatterMatch[2].split('\n');
		const fm = {};
		for (const line of fmLines) {
			const [key, ...rest] = line.split(':');
			if (key.trim()) {
				fm[key.trim()] = rest.join(':').trim();
			}
		}
		if (Object.prototype.hasOwnProperty.call(fm, 'title')) {
			title = fm.title;
		}
		const fmEndIdx = frontmatterMatch.index + frontmatterMatch[0].length;
		remaining = content.slice(fmEndIdx);
	}

	// Extract headings (lines starting with #)
	const headingRegex = /^#{1,6}\s+(.*)$/gm;
	let match;
	while ((match = headingRegex.exec(remaining))) {
		const text = match[1].trim();
		headings.push(text);
		remaining =
			remaining.slice(0, match.index) +
			remaining.slice(match.index + match[0].length);
	}

	// Extract body (everything else)
	const bodyStartIdx = remaining.search(/\S/);
	if (bodyStartIdx !== -1) {
		body = remaining.slice(bodyStartIdx);
	} else {
		body = '';
	}

	// Fallback: use first heading as title if no title found
	if (!title && headings.length > 0) {
		title = headings[0];
	}

	return { title, headings, body };
}

/**
 * Creates a short snippet around the first matched query term.
 * @param {{title: string, headings: string[], body: string}} doc - parsed document.
 * @param {string[]} terms - normalized query terms.
 * @returns {string} snippet text.
 */
export function createSnippet(doc, terms) {
	const combined = `${doc.title}\n${doc.headings.join('\n')}\n\n${doc.body}`;
	for (const term of terms) {
		const regex = new RegExp(`(${term})`, 'i');
		const idx = combined.search(regex);
		if (idx !== -1) {
			const start = Math.max(0, idx - 30);
			const end = Math.min(combined.length, idx + term.length + 30);
			return combined.slice(start, end);
		}
	}

	return doc.body.length > 100 ? `${doc.body.slice(0, 100)}...` : doc.body;
}

/**
 * Builds an index of markdown files.
 * @param {string} root - directory root.
 * @returns {Promise<Map<string, object>>} Map of filePath -> parsed document data.
 */
export async function buildIndex(root) {
	const filesMap = await readMarkdownFiles(root);
	const index = new Map();
	for (const [filePath, content] of filesMap) {
		const parsed = parseMarkdownDocument(filePath, content);
		index.set(filePath, parsed);
	}
	return index;
}

/**
 * Searches the given index.
 * @param {Map<string, object>} index - map from filePath to parsed document data.
 * @param {string} query - search terms.
 * @param {object} [options] - optional parameters (currently unused).
 * @returns {Array<{path: string, title: string, score: number, snippet: string}>}
 */
export function searchIndex(index, query, options) {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [];

	const results = [];

	for (const [filePath, doc] of index) {
		let score = 0;

		// Title weight (3)
		const titleLC = doc.title.toLowerCase();
		for (const term of terms) {
			if (titleLC.includes(term)) {
				score += 3;
			}
		}

		// Headings weight (2)
		for (const heading of doc.headings) {
			const headingLC = heading.toLowerCase();
			for (const term of terms) {
				if (headingLC.includes(term)) {
					score += 2;
				}
			}
		}

		// Body weight (1)
		const bodyLC = doc.body.toLowerCase();
		for (const term of terms) {
			if (bodyLC.includes(term)) {
				score += 1;
			}
		}

		// Only include documents with a positive score
		if (score <= 0) continue;

		const snippet = createSnippet(doc, terms);

		results.push({
			path: filePath,
			title: doc.title,
			score,
			snippet,
		});
	}

	// Sort by score descending, then by path for stability
	results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return results;
}

/**
 * Alias required by existing tests.
 */
export async function loadIndex(root) {
	return buildIndex(root);
}

/**
 * Test-compatible wrapper.
 */
export function searchFiles(index, query, options) {
	return searchIndex(index, query, options);
}
