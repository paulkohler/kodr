import { readTextPrefix } from './workspace-files.mjs';

const INSPECTION_MAX_CHUNKS = 12;
const INSPECTION_CONTEXT_LINES = 2;
const FALLBACK_READ_BYTES = 20000;

/**
 * Build candidate inspection chunks from a list of ranked symbol matches.
 * Returns at most INSPECTION_MAX_CHUNKS chunks covering symbol bodies,
 * imports, reference sites, and related tests.
 */
export async function buildInspectionChunks(cwd, index, matches) {
	const chunks = [];
	const seen = new Set();

	for (const match of matches) {
		await addSymbolChunk(cwd, index, chunks, seen, match, 'symbol');
		await addImportChunk(cwd, index, chunks, seen, match.path);
		await addReferenceChunks(cwd, index, chunks, seen, match.name);
		await addRelatedTestChunks(cwd, index, chunks, seen, match);
		if (chunks.length >= INSPECTION_MAX_CHUNKS) {
			break;
		}
	}

	return chunks.slice(0, INSPECTION_MAX_CHUNKS);
}

/**
 * Select chunks within a character budget. Truncates the first chunk rather
 * than dropping it when the budget is smaller than any single chunk.
 *
 * Returns { chunks, droppedChunks, droppedChars, usedChars }.
 */
export function selectInspectionChunks(
	chunks,
	budgetChars = FALLBACK_READ_BYTES,
) {
	const selected = [];
	let used = 0;
	let droppedChars = 0;
	let droppedChunks = 0;
	for (const chunk of chunks) {
		const bytes = Buffer.byteLength(chunk.content || '');
		if (used + bytes <= budgetChars) {
			selected.push({ ...chunk, estimatedChars: bytes });
			used += bytes;
		} else if (selected.length === 0 && budgetChars > 0) {
			const content = truncateUtf8(chunk.content || '', budgetChars);
			const estimatedChars = Buffer.byteLength(content);
			selected.push({
				...chunk,
				content,
				estimatedChars,
				truncated: true,
			});
			used += estimatedChars;
			droppedChars += bytes - estimatedChars;
			droppedChunks += 1;
		} else {
			droppedChars += bytes;
			droppedChunks += 1;
		}
	}
	return { chunks: selected, droppedChars, droppedChunks, usedChars: used };
}

/**
 * Filter ranked symbols to those whose names match the query terms.
 * Returns symbols in rank order that are relevant to the query.
 */
export function matchingSymbols(symbols, terms) {
	if (terms.length === 0) {
		return [];
	}
	const exactNames = terms.filter((term) => term.includes(':exact:'));
	if (exactNames.length > 0) {
		const exact = exactNames.map((term) => term.replace(':exact:', ''));
		return symbols.filter((symbol) => {
			const name = normalizeSymbolName(symbol.name);
			return exact.some((term) => name === term || name.includes(term));
		});
	}
	return symbols.filter((symbol) => {
		const haystack = symbolTokens(symbol.name);
		return terms.some((term) => haystack.includes(term));
	});
}

/**
 * Tokenize a query string for use with matchingSymbols.
 * Exact identifiers (camelCase, long names) become `:exact:` terms;
 * otherwise returns lowercased tokens of length >= 3.
 */
export function queryTokens(query) {
	const exactIdentifiers = [...query.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/gu)]
		.map((match) => match[0])
		.filter((token) => /[A-Z_]/u.test(token) || token.length >= 12)
		.map((token) => `${normalizeSymbolName(token)}:exact:`);
	if (exactIdentifiers.length > 0) {
		return exactIdentifiers.slice(0, 10);
	}
	return normalizeTokens(query)
		.filter((token) => token.length >= 3)
		.slice(0, 20);
}

async function addSymbolChunk(cwd, index, chunks, seen, symbol, kind) {
	const key = `${symbol.path}:${symbol.lineStart}-${symbol.lineEnd}:${kind}`;
	if (seen.has(key)) {
		return;
	}
	const lines = await fileLines(cwd, index, symbol.path);
	if (!lines.length) {
		return;
	}
	const lineStart = Math.max(1, symbol.lineStart);
	const lineEnd = Math.min(lines.length, symbol.lineEnd);
	const content = lines.slice(lineStart - 1, lineEnd).join('\n');
	chunks.push({
		content,
		kind,
		lineEnd,
		lineStart,
		name: symbol.name,
		path: `${symbol.path}#${symbol.name}:${lineStart}-${lineEnd}`,
		sourcePath: symbol.path,
	});
	seen.add(key);
}

async function addImportChunk(cwd, index, chunks, seen, path) {
	const file = index.files.find((item) => item.path === path);
	if (!file || file.imports.length === 0) {
		return;
	}
	const lineStart = file.imports[0].line;
	const lineEnd = file.imports.at(-1).line;
	const key = `${path}:${lineStart}-${lineEnd}:imports`;
	if (seen.has(key)) {
		return;
	}
	const lines = await fileLines(cwd, index, path);
	const content = lines.slice(lineStart - 1, lineEnd).join('\n');
	chunks.push({
		content,
		kind: 'imports',
		lineEnd,
		lineStart,
		name: 'imports',
		path: `${path}#imports:${lineStart}-${lineEnd}`,
		sourcePath: path,
	});
	seen.add(key);
}

async function addReferenceChunks(cwd, index, chunks, seen, symbolName) {
	const boundary = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'u');
	for (const file of index.files) {
		const lines = await fileLines(cwd, index, file.path);
		for (const [offset, text] of lines.entries()) {
			if (!boundary.test(text)) {
				continue;
			}
			const line = offset + 1;
			const lineStart = Math.max(1, line - INSPECTION_CONTEXT_LINES);
			const lineEnd = Math.min(lines.length, line + INSPECTION_CONTEXT_LINES);
			const key = `${file.path}:${lineStart}-${lineEnd}:reference:${symbolName}`;
			if (seen.has(key)) {
				continue;
			}
			chunks.push({
				content: lines.slice(lineStart - 1, lineEnd).join('\n'),
				kind: 'reference',
				lineEnd,
				lineStart,
				name: symbolName,
				path: `${file.path}#ref-${symbolName}:${lineStart}-${lineEnd}`,
				sourcePath: file.path,
			});
			seen.add(key);
			if (chunks.length >= INSPECTION_MAX_CHUNKS) {
				return;
			}
		}
	}
}

async function addRelatedTestChunks(cwd, index, chunks, seen, match) {
	for (const symbol of index.symbols) {
		if (symbol.kind !== 'test') {
			continue;
		}
		const testPath = symbol.path.toLowerCase();
		const sameFile = symbol.path === match.path;
		const testFile = testPath.includes('test') || testPath.endsWith('_test.go');
		if (!sameFile && !testFile) {
			continue;
		}
		const lines = await fileLines(cwd, index, symbol.path);
		const body = lines
			.slice(symbol.lineStart - 1, Math.min(lines.length, symbol.lineEnd))
			.join('\n');
		if (!body.includes(match.name) && !symbol.name.includes(match.name)) {
			continue;
		}
		await addSymbolChunk(cwd, index, chunks, seen, symbol, 'related-test');
		if (chunks.length >= INSPECTION_MAX_CHUNKS) {
			return;
		}
	}
}

async function fileLines(cwd, index, path) {
	const file = index.files.find((item) => item.path === path);
	if (file?.contentLines) {
		return file.contentLines.map((line) => line.text);
	}
	const content = await readTextPrefix(`${cwd}/${path}`, FALLBACK_READ_BYTES);
	return content ? content.split(/\r?\n/u) : [];
}

function symbolTokens(value) {
	return normalizeTokens(value).join(' ');
}

function normalizeTokens(value) {
	return value
		.replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

function normalizeSymbolName(value) {
	return normalizeTokens(value).join('');
}

function truncateUtf8(value, maxBytes) {
	return Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8');
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
