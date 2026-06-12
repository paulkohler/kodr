import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildFileMap,
	buildFileSummaries,
	buildInspectionChunks,
	classifyLanguage,
	findReferences,
	inspectFile,
	inspectWorkspace,
	listContextFiles,
	looksBinary,
	matchingSymbols,
	queryTokens,
	rankSymbols,
	readTextPrefix,
	renderFileMapText,
	renderInspectionSummary,
	selectInspectionChunks,
} from '../src/index.mjs';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fixture(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}

async function tempDir(prefix = 'kodr-repomap-pkg-') {
	return mkdtemp(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// listContextFiles
// ---------------------------------------------------------------------------

describe('listContextFiles', () => {
	it('walks a temp dir and finds files', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, 'src/lib.mjs', 'export function lib() {}');
		await fixture(cwd, 'README.md', '# readme');

		const files = await listContextFiles(cwd);
		assert.ok(files.includes('README.md'), 'finds README.md');
		assert.ok(files.includes('src/app.mjs'), 'finds src/app.mjs');
		assert.ok(files.includes('src/lib.mjs'), 'finds src/lib.mjs');
	});

	it('skips node_modules and .git by default', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, 'node_modules/dep/index.js', 'module.exports = {}');
		await fixture(cwd, '.git/config', '[core]');

		const files = await listContextFiles(cwd);
		assert.ok(files.includes('src/app.mjs'), 'includes src/app.mjs');
		assert.ok(
			!files.some((f) => f.startsWith('node_modules/')),
			'excludes node_modules',
		);
		assert.ok(!files.some((f) => f.startsWith('.git/')), 'excludes .git');
	});

	it('respects custom ignore names', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, 'vendor/lib.mjs', 'export function lib() {}');

		const files = await listContextFiles(cwd, { ignore: ['vendor'] });
		assert.ok(!files.some((f) => f.startsWith('vendor/')), 'excludes vendor');
	});

	it('respects ignorePatterns', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, '.cache/data.json', '{}');

		const files = await listContextFiles(cwd, {
			ignorePatterns: [/^\.cache(?:$|-)/u],
		});
		assert.ok(!files.some((f) => f.startsWith('.cache/')), 'excludes .cache');
	});

	it('returns paths sorted alphabetically', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'z.mjs', '');
		await fixture(cwd, 'a.mjs', '');
		await fixture(cwd, 'm.mjs', '');

		const files = await listContextFiles(cwd);
		const sorted = [...files].sort((a, b) => a.localeCompare(b));
		assert.deepEqual(files, sorted, 'files are sorted');
	});
});

// ---------------------------------------------------------------------------
// looksBinary / readTextPrefix
// ---------------------------------------------------------------------------

describe('looksBinary', () => {
	it('returns false for empty buffer', () => {
		assert.equal(looksBinary(Buffer.alloc(0)), false);
	});

	it('returns true when null bytes present', () => {
		assert.equal(looksBinary(Buffer.from([65, 0, 66])), true);
	});

	it('returns false for normal text', () => {
		assert.equal(looksBinary(Buffer.from('hello world')), false);
	});
});

describe('readTextPrefix', () => {
	it('reads a text file up to maxBytes', async () => {
		const cwd = await tempDir();
		const path = join(cwd, 'test.mjs');
		await writeFile(path, 'export const x = 1;');
		const content = await readTextPrefix(path, 20000);
		assert.ok(typeof content === 'string', 'returns string for text file');
		assert.ok(content.includes('export const x'), 'content is correct');
	});
});

// ---------------------------------------------------------------------------
// classifyLanguage
// ---------------------------------------------------------------------------

describe('classifyLanguage', () => {
	it('identifies common extensions', () => {
		assert.equal(classifyLanguage('src/app.mjs'), 'javascript');
		assert.equal(classifyLanguage('src/app.js'), 'javascript');
		assert.equal(classifyLanguage('src/app.jsx'), 'javascript');
		assert.equal(classifyLanguage('src/app.cjs'), 'javascript');
		assert.equal(classifyLanguage('src/app.ts'), 'typescript');
		assert.equal(classifyLanguage('src/app.tsx'), 'typescript');
		assert.equal(classifyLanguage('src/app.py'), 'python');
		assert.equal(classifyLanguage('src/app.rs'), 'rust');
		assert.equal(classifyLanguage('src/app.go'), 'go');
		assert.equal(classifyLanguage('README.md'), 'unknown');
		assert.equal(classifyLanguage('config.json'), 'unknown');
	});
});

// ---------------------------------------------------------------------------
// inspectFile
// ---------------------------------------------------------------------------

describe('inspectFile', () => {
	it('extracts symbols from a JS file', () => {
		const source = [
			"import { readFile } from 'node:fs/promises';",
			'',
			'export function parseInput(text) {',
			'  return text.trim();',
			'}',
			'',
			'export class Parser {',
			'  run() {}',
			'}',
			'',
			'export const MAX_LEN = 100;',
		].join('\n');

		const entry = inspectFile('src/parser.mjs', source);

		assert.equal(entry.path, 'src/parser.mjs');
		assert.equal(entry.language, 'javascript');
		assert.ok(entry.lineCount > 0, 'has lineCount');

		const names = entry.symbols.map((s) => s.name);
		assert.ok(names.includes('parseInput'), 'found parseInput');
		assert.ok(names.includes('Parser'), 'found Parser class');

		const fnSym = entry.symbols.find((s) => s.name === 'parseInput');
		assert.equal(fnSym.kind, 'function');
		assert.ok(fnSym.lineStart > 0, 'has lineStart');

		const classSym = entry.symbols.find((s) => s.name === 'Parser');
		assert.equal(classSym.kind, 'class');
	});

	it('extracts imports from a JS file', () => {
		const source = [
			"import { readFile } from 'node:fs/promises';",
			"import { join } from 'node:path';",
			'',
			'export function app() {}',
		].join('\n');

		const entry = inspectFile('src/app.mjs', source);
		assert.ok(entry.imports.length >= 2, 'found imports');
		assert.ok(
			entry.imports.some((i) => i.specifier.includes('node:fs/promises')),
			'found fs import',
		);
	});

	it('classifies language from path when not provided', () => {
		const entry = inspectFile('lib/util.py', 'def helper():\n  pass\n');
		assert.equal(entry.language, 'python');
	});
});

// ---------------------------------------------------------------------------
// inspectWorkspace
// ---------------------------------------------------------------------------

describe('inspectWorkspace', () => {
	it('builds a full index from a temp workspace', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			[
				"import { readFile } from 'node:fs/promises';",
				'',
				'export function parseInput(text) { return text.trim(); }',
				'export function validateInput(text) { return text.length > 0; }',
			].join('\n'),
		);
		await fixture(
			cwd,
			'src/util.mjs',
			'export function formatOutput(val) { return String(val); }',
		);

		const index = await inspectWorkspace(cwd);

		assert.ok(index.files.length >= 2, 'indexed at least 2 files');
		assert.ok(index.totalFiles >= 2, 'totalFiles set');
		assert.ok(index.totalSymbols > 0, 'totalSymbols set');
		assert.ok(Array.isArray(index.symbols), 'symbols is array');
		assert.ok(typeof index.languages === 'object', 'languages is object');
		assert.ok(index.languages.javascript >= 2, 'counted javascript files');

		for (const file of index.files) {
			assert.ok(
				Array.isArray(file.contentLines),
				`${file.path} has contentLines`,
			);
			assert.ok(
				file.contentLines.length > 0,
				`${file.path} contentLines non-empty`,
			);
		}
	});

	it('filters by language option', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, 'src/util.py', 'def util(): pass');

		const index = await inspectWorkspace(cwd, { languages: ['javascript'] });
		assert.ok(
			index.files.every((f) => f.language === 'javascript'),
			'only javascript files',
		);
	});

	it('pre-computes rankedSymbols when query is given', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			'export function parseInput(text) { return text.trim(); }',
		);

		const index = await inspectWorkspace(cwd, { query: 'parseInput' });
		assert.ok(Array.isArray(index.rankedSymbols), 'rankedSymbols is array');
		assert.ok(index.rankedSymbols.length > 0, 'rankedSymbols non-empty');
		assert.equal(
			index.rankedSymbols[0].name,
			'parseInput',
			'top rank is parseInput',
		);
	});
});

// ---------------------------------------------------------------------------
// findReferences
// ---------------------------------------------------------------------------

describe('findReferences', () => {
	it('finds cross-file references to a symbol name', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			'export function parseInput(text) { return text.trim(); }',
		);
		await fixture(
			cwd,
			'src/app.mjs',
			[
				"import { parseInput } from './parser.mjs';",
				'export function run(text) { return parseInput(text); }',
			].join('\n'),
		);

		const index = await inspectWorkspace(cwd);
		const refs = findReferences(index, 'parseInput');
		assert.ok(refs.length >= 1, 'found at least one reference');
		assert.ok(
			refs.every(
				(r) => typeof r.path === 'string' && typeof r.line === 'number',
			),
			'refs have path and line',
		);
	});

	it('returns empty array for unknown symbol', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');

		const index = await inspectWorkspace(cwd);
		const refs = findReferences(index, 'nonExistentSymbolXYZ');
		assert.deepEqual(refs, []);
	});
});

// ---------------------------------------------------------------------------
// rankSymbols
// ---------------------------------------------------------------------------

describe('rankSymbols', () => {
	it('ranks by query relevance', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			[
				'export function parseInput(text) { return text; }',
				'export function formatOutput(val) { return val; }',
				'export class InputParser {}',
			].join('\n'),
		);

		const index = await inspectWorkspace(cwd);
		const ranked = rankSymbols(index, { query: 'parseInput' });

		assert.ok(Array.isArray(ranked), 'returns array');
		assert.ok(ranked.length > 0, 'non-empty');
		assert.equal(ranked[0].name, 'parseInput', 'parseInput ranks first');

		for (const sym of ranked) {
			assert.ok(typeof sym.rank === 'object', 'each symbol has rank object');
			assert.ok(typeof sym.rank.score === 'number', 'rank has score');
		}
	});

	it('returns all symbols when no query given', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/app.mjs',
			'export function app() {}\nexport function helper() {}',
		);

		const index = await inspectWorkspace(cwd);
		const ranked = rankSymbols(index, {});
		assert.equal(ranked.length, index.symbols.length, 'all symbols returned');
	});
});

// ---------------------------------------------------------------------------
// queryTokens + matchingSymbols
// ---------------------------------------------------------------------------

describe('queryTokens', () => {
	it('tokenizes a plain query into lowercase tokens', () => {
		const tokens = queryTokens('parse input validation');
		assert.ok(tokens.includes('parse'), 'contains parse');
		assert.ok(tokens.includes('input'), 'contains input');
		assert.ok(tokens.includes('validation'), 'contains validation');
	});

	it('produces :exact: terms for camelCase identifiers', () => {
		const tokens = queryTokens('parseInput');
		assert.ok(
			tokens.some((t) => t.includes(':exact:')),
			'has exact term',
		);
	});
});

describe('matchingSymbols', () => {
	it('filters ranked symbols to those matching query terms', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			[
				'export function parseInput(text) { return text; }',
				'export function formatOutput(val) { return val; }',
			].join('\n'),
		);

		const index = await inspectWorkspace(cwd);
		const ranked = rankSymbols(index, { query: 'parseInput' });
		const terms = queryTokens('parseInput');
		const matches = matchingSymbols(ranked, terms);

		assert.ok(
			matches.some((s) => s.name === 'parseInput'),
			'parseInput is in matches',
		);
	});

	it('returns empty array when terms is empty', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');

		const index = await inspectWorkspace(cwd);
		const ranked = rankSymbols(index, {});
		const matches = matchingSymbols(ranked, []);
		assert.deepEqual(matches, []);
	});
});

// ---------------------------------------------------------------------------
// buildInspectionChunks + selectInspectionChunks
// ---------------------------------------------------------------------------

describe('buildInspectionChunks', () => {
	it('produces chunks for matching symbols', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			[
				"import { readFile } from 'node:fs/promises';",
				'',
				'export function parseInput(text) {',
				'  return text.trim();',
				'}',
			].join('\n'),
		);

		const index = await inspectWorkspace(cwd, { query: 'parseInput' });
		const ranked = rankSymbols(index, { query: 'parseInput' });
		const terms = queryTokens('parseInput');
		const matches = matchingSymbols(ranked, terms);

		const chunks = await buildInspectionChunks(cwd, index, matches);

		assert.ok(Array.isArray(chunks), 'returns array');
		assert.ok(chunks.length >= 1, 'at least one chunk');

		for (const chunk of chunks) {
			assert.ok(typeof chunk.content === 'string', 'chunk has content string');
			assert.ok(typeof chunk.kind === 'string', 'chunk has kind string');
			assert.ok(typeof chunk.path === 'string', 'chunk has path string');
			assert.ok(typeof chunk.sourcePath === 'string', 'chunk has sourcePath');
		}
	});
});

describe('selectInspectionChunks', () => {
	it('selects chunks within a character budget', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/parser.mjs',
			[
				"import { readFile } from 'node:fs/promises';",
				'',
				'export function parseInput(text) {',
				'  return text.trim();',
				'}',
			].join('\n'),
		);

		const index = await inspectWorkspace(cwd, { query: 'parseInput' });
		const ranked = rankSymbols(index, { query: 'parseInput' });
		const terms = queryTokens('parseInput');
		const matches = matchingSymbols(ranked, terms);
		const chunks = await buildInspectionChunks(cwd, index, matches);

		const budget = 2000;
		const result = selectInspectionChunks(chunks, budget);

		assert.ok(Array.isArray(result.chunks), 'result.chunks is array');
		assert.ok(result.chunks.length >= 1, 'at least one chunk selected');
		assert.ok(result.usedChars <= budget, 'usedChars within budget');
		assert.ok(
			typeof result.droppedChunks === 'number',
			'droppedChunks is number',
		);
		assert.ok(
			typeof result.droppedChars === 'number',
			'droppedChars is number',
		);
	});

	it('truncates rather than dropping when budget smaller than first chunk', () => {
		const chunks = [
			{
				content: 'a'.repeat(500),
				kind: 'symbol',
				lineEnd: 10,
				lineStart: 1,
				name: 'foo',
				path: 'src/foo.mjs#foo:1-10',
				sourcePath: 'src/foo.mjs',
			},
		];
		const result = selectInspectionChunks(chunks, 100);
		assert.equal(result.chunks.length, 1, 'one chunk selected (truncated)');
		assert.ok(result.chunks[0].truncated === true, 'chunk is marked truncated');
		assert.ok(result.usedChars <= 100, 'usedChars within budget');
	});
});

// ---------------------------------------------------------------------------
// buildFileMap + renderFileMapText
// ---------------------------------------------------------------------------

describe('buildFileMap + renderFileMapText', () => {
	it('buildFileMap produces entries with sizes', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, 'README.md', '# hello');

		const files = await listContextFiles(cwd);
		const fileMap = await buildFileMap(cwd, files);

		assert.ok(Array.isArray(fileMap.entries), 'entries is array');
		assert.ok(fileMap.entries.length >= 2, 'at least two entries');
		assert.ok(fileMap.total >= 2, 'total set');
		assert.equal(fileMap.hidden, 0, 'no hidden files');

		for (const entry of fileMap.entries) {
			assert.ok(typeof entry.path === 'string', 'entry has path');
			assert.ok(typeof entry.size === 'number', 'entry has size');
		}
	});

	it('renderFileMapText produces readable output', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');

		const files = await listContextFiles(cwd);
		const fileMap = await buildFileMap(cwd, files);
		const text = renderFileMapText(fileMap);

		assert.ok(typeof text === 'string', 'returns string');
		assert.ok(text.includes('src/app.mjs'), 'includes file path');
		assert.ok(text.includes('bytes'), 'mentions bytes');
	});
});

// ---------------------------------------------------------------------------
// buildFileSummaries + renderInspectionSummary
// ---------------------------------------------------------------------------

describe('buildFileSummaries', () => {
	it('produces compact per-file summaries', async () => {
		const cwd = await tempDir();
		await fixture(
			cwd,
			'src/app.mjs',
			[
				"import { join } from 'node:path';",
				'export function app() {}',
				'export class App {}',
			].join('\n'),
		);

		const index = await inspectWorkspace(cwd);
		const summaries = buildFileSummaries(index.files);

		assert.ok(Array.isArray(summaries), 'returns array');
		assert.ok(summaries.length >= 1, 'at least one summary');

		const s = summaries[0];
		assert.ok(typeof s.path === 'string', 'summary has path');
		assert.ok(typeof s.language === 'string', 'summary has language');
		assert.ok(typeof s.lineCount === 'number', 'summary has lineCount');
		assert.ok(typeof s.importCount === 'number', 'summary has importCount');
		assert.ok(Array.isArray(s.symbols), 'summary has symbols array');
	});
});

describe('renderInspectionSummary', () => {
	it('produces a Markdown section', async () => {
		const cwd = await tempDir();
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');

		const index = await inspectWorkspace(cwd, { query: 'app' });
		const ranked = rankSymbols(index, { query: 'app' });
		const terms = queryTokens('app');
		const matches = matchingSymbols(ranked, terms);
		const chunks = await buildInspectionChunks(cwd, index, matches);
		const selected = selectInspectionChunks(chunks, 20000);
		const summaries = buildFileSummaries(index.files);

		const md = renderInspectionSummary({
			mode: 'inspection-aware',
			totalFileCount: index.totalFiles,
			totalSymbolCount: index.totalSymbols,
			selectedSymbolCount: matches.length,
			rankedSymbolCount: ranked.length,
			chunks: selected.chunks,
			droppedChunks: selected.droppedChunks,
			droppedChars: selected.droppedChars,
			fileSummaries: summaries,
			query: 'app',
		});

		assert.ok(typeof md === 'string', 'returns string');
		assert.ok(md.includes('## Inspection context'), 'has heading');
		assert.ok(md.includes('Files indexed:'), 'has files indexed');
	});
});

// ---------------------------------------------------------------------------
// Full round-trip
// ---------------------------------------------------------------------------

describe('round-trip: walk → inspect → rank → select → render', () => {
	it('produces a complete context from a minimal workspace', async () => {
		const cwd = await tempDir();

		await fixture(
			cwd,
			'src/parser.mjs',
			[
				"import { readFile } from 'node:fs/promises';",
				'',
				'export function parseInput(text) {',
				'  return text.trim();',
				'}',
				'',
				'export function validateInput(text) {',
				'  return parseInput(text).length > 0;',
				'}',
			].join('\n'),
		);
		await fixture(
			cwd,
			'test/parser.test.mjs',
			[
				"import { parseInput } from '../src/parser.mjs';",
				'',
				"test('parseInput trims whitespace', () => {",
				"  assert.equal(parseInput('  hi  '), 'hi');",
				'});',
			].join('\n'),
		);

		// step 1: walk
		const files = await listContextFiles(cwd);
		assert.ok(files.length >= 2, 'found files');

		// step 2: inspect workspace
		const index = await inspectWorkspace(cwd, { query: 'parseInput' });
		assert.ok(index.totalFiles >= 2, 'indexed files');
		assert.ok(index.totalSymbols >= 1, 'found symbols');

		// step 3: rank
		const ranked = rankSymbols(index, { query: 'parseInput' });
		assert.ok(ranked.length > 0, 'ranked symbols');
		assert.equal(ranked[0].name, 'parseInput', 'parseInput ranked first');

		// step 4: select chunks
		const terms = queryTokens('parseInput');
		const matches = matchingSymbols(ranked, terms);
		assert.ok(matches.length >= 1, 'found matching symbols');

		const chunks = await buildInspectionChunks(cwd, index, matches);
		assert.ok(chunks.length >= 1, 'built chunks');

		const selected = selectInspectionChunks(chunks, 10000);
		assert.ok(selected.chunks.length >= 1, 'selected chunks');
		assert.ok(selected.usedChars <= 10000, 'within budget');

		// step 5: render
		const fileMap = await buildFileMap(cwd, files);
		const fileMapText = renderFileMapText(fileMap);
		assert.ok(
			fileMapText.includes('src/parser.mjs'),
			'file map includes parser',
		);

		const summaries = buildFileSummaries(index.files);
		const md = renderInspectionSummary({
			mode: 'inspection-aware',
			totalFileCount: index.totalFiles,
			totalSymbolCount: index.totalSymbols,
			selectedSymbolCount: matches.length,
			rankedSymbolCount: ranked.length,
			chunks: selected.chunks,
			droppedChunks: selected.droppedChunks,
			droppedChars: selected.droppedChars,
			fileSummaries: summaries,
			query: 'parseInput',
		});
		assert.ok(md.includes('## Inspection context'), 'summary has heading');
		assert.ok(md.includes('src/parser.mjs'), 'summary references parser');
	});
});
