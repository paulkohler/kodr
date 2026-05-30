import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { listContextFiles } from './context-packer.mjs';

const MAX_INSPECT_BYTES = 200000;

export async function inspectWorkspace(cwd, options = {}) {
	const files = await listContextFiles(cwd);
	const inspected = [];

	for (const path of files) {
		const language = classifyLanguage(path);
		if (language === 'unknown') {
			continue;
		}

		const content = await readInspectableFile(`${cwd}/${path}`);
		if (content === null) {
			continue;
		}

		const inspectedFile = inspectFile(path, content, language);
		Object.defineProperty(inspectedFile, '_contentLines', {
			value: content.split(/\r?\n/u).map((text, index) => ({
				number: index + 1,
				text,
			})),
		});
		inspected.push(inspectedFile);
	}

	const index = {
		files: inspected,
		languages: countLanguages(inspected),
		references: [],
		symbols: inspected.flatMap((file) =>
			file.symbols.map((symbol) => ({
				...symbol,
				language: file.language,
				path: file.path,
			})),
		),
	};

	if (options.symbol) {
		index.references = findReferences(index, options.symbol);
	}

	return index;
}

export function classifyLanguage(path) {
	const ext = extname(path).toLowerCase();
	if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') {
		return 'javascript';
	}
	if (ext === '.ts' || ext === '.tsx') {
		return 'typescript';
	}
	if (ext === '.py') {
		return 'python';
	}
	if (ext === '.rs') {
		return 'rust';
	}
	if (ext === '.go') {
		return 'go';
	}
	return 'unknown';
}

export function inspectFile(path, content, language = classifyLanguage(path)) {
	const lines = content.split(/\r?\n/u);
	const imports = extractImports(lines, language);
	const starts = extractSymbolStarts(path, lines, language);
	const symbols = starts.map((start, index) => {
		const next = starts[index + 1];
		return {
			kind: start.kind,
			lineEnd: next ? next.lineStart - 1 : lines.length,
			lineStart: start.lineStart,
			name: start.name,
		};
	});

	return {
		imports,
		language,
		lineCount: lines.length,
		path,
		symbols,
	};
}

export function findReferences(index, symbolName) {
	if (!symbolName) {
		return [];
	}

	const references = [];
	const boundary = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'u');

	for (const file of index.files) {
		for (const line of file._contentLines || []) {
			if (boundary.test(line.text)) {
				references.push({
					line: line.number,
					path: file.path,
					text: line.text.trim(),
				});
			}
		}
	}

	if (references.length > 0) {
		return references;
	}

	return index.files.flatMap((file) =>
		file.symbols
			.filter((symbol) => symbol.name === symbolName)
			.map((symbol) => ({
				line: symbol.lineStart,
				path: file.path,
				text: `${symbol.kind} ${symbol.name}`,
			})),
	);
}

async function readInspectableFile(path) {
	try {
		const buffer = await readFile(path);
		if (buffer.length > MAX_INSPECT_BYTES || buffer.includes(0)) {
			return null;
		}
		return buffer.toString('utf8');
	} catch {
		return null;
	}
}

function extractImports(lines, language) {
	if (language === 'javascript' || language === 'typescript') {
		return lines
			.map((line, index) => ({ index, line: line.trim() }))
			.filter(
				({ line }) =>
					/^import\s/u.test(line) || /^export\s+.+\s+from\s/u.test(line),
			)
			.map(({ index, line }) => ({ line: index + 1, specifier: line }));
	}

	if (language === 'python') {
		return lines
			.map((line, index) => ({ index, line: line.trim() }))
			.filter(
				({ line }) =>
					/^import\s/u.test(line) || /^from\s+\S+\s+import\s/u.test(line),
			)
			.map(({ index, line }) => ({ line: index + 1, specifier: line }));
	}

	if (language === 'rust') {
		return lines
			.map((line, index) => ({ index, line: line.trim() }))
			.filter(({ line }) => /^(use|mod)\s/u.test(line))
			.map(({ index, line }) => ({ line: index + 1, specifier: line }));
	}

	if (language === 'go') {
		return lines
			.map((line, index) => ({ index, line: line.trim() }))
			.filter(({ line }) => /^import\s/u.test(line) || /^"[^"]+"$/u.test(line))
			.map(({ index, line }) => ({ line: index + 1, specifier: line }));
	}

	return [];
}

function extractSymbolStarts(path, lines, language) {
	if (language === 'javascript' || language === 'typescript') {
		return extractJsSymbols(lines);
	}
	if (language === 'python') {
		return extractPythonSymbols(lines);
	}
	if (language === 'rust') {
		return extractRustSymbols(lines);
	}
	if (language === 'go') {
		return extractGoSymbols(path, lines);
	}
	return [];
}

function extractJsSymbols(lines) {
	const symbols = [];
	for (const [index, rawLine] of lines.entries()) {
		if (/^\s/u.test(rawLine)) {
			continue;
		}
		const line = rawLine.trim();
		let match = line.match(
			/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u,
		);
		if (match) {
			symbols.push(symbol(index, 'function', match[1]));
			continue;
		}
		match = line.match(
			/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/u,
		);
		if (match) {
			symbols.push(symbol(index, 'class', match[1]));
			continue;
		}
		match = line.match(
			/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)?\s*=>/u,
		);
		if (match) {
			symbols.push(symbol(index, 'function', match[1]));
			continue;
		}
		match = line.match(
			/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u,
		);
		if (match) {
			symbols.push(symbol(index, 'variable', match[1]));
			continue;
		}
		match = line.match(/^(?:describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/u);
		if (match) {
			symbols.push(symbol(index, 'test', match[1]));
		}
	}
	return symbols;
}

function extractPythonSymbols(lines) {
	const symbols = [];
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (rawLine.match(/^\S/u) === null) {
			continue;
		}
		let match = line.match(/^class\s+([A-Za-z_]\w*)/u);
		if (match) {
			symbols.push(symbol(index, 'class', match[1]));
			continue;
		}
		match = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/u);
		if (match) {
			symbols.push(
				symbol(
					index,
					match[1].startsWith('test_') ? 'test' : 'function',
					match[1],
				),
			);
		}
	}
	return symbols;
}

function extractRustSymbols(lines) {
	const symbols = [];
	let pendingTest = false;
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (line === '#[test]') {
			pendingTest = true;
			continue;
		}
		const match = line.match(
			/^(?:pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)?/u,
		);
		if (!match) {
			continue;
		}
		const kind = pendingTest && match[1] === 'fn' ? 'test' : rustKind(match[1]);
		const name = match[2] || `impl@${index + 1}`;
		symbols.push(symbol(index, kind, name));
		pendingTest = false;
	}
	return symbols;
}

function extractGoSymbols(path, lines) {
	const symbols = [];
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		let match = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/u);
		if (match) {
			const isTestFile = path.endsWith('_test.go');
			const kind =
				isTestFile && match[1].startsWith('Test') ? 'test' : 'function';
			symbols.push(symbol(index, kind, match[1]));
			continue;
		}
		match = line.match(
			/^type\s+([A-Za-z_]\w*)\s+(struct|interface|[A-Za-z_]\w*)/u,
		);
		if (match) {
			symbols.push(
				symbol(
					index,
					match[2] === 'interface' ? 'interface' : 'type',
					match[1],
				),
			);
		}
	}
	return symbols;
}

function countLanguages(files) {
	const counts = {};
	for (const file of files) {
		counts[file.language] = (counts[file.language] || 0) + 1;
	}
	return counts;
}

function rustKind(kind) {
	if (kind === 'fn') {
		return 'function';
	}
	return kind;
}

function symbol(index, kind, name) {
	return { kind, lineStart: index + 1, name };
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
