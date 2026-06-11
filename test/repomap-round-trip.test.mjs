import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	buildInspectionChunks,
	inspectWorkspace,
	matchingSymbols,
	queryTokens,
	rankSymbols,
	selectInspectionChunks,
} from '../src/repomap/index.mjs';

describe('repomap public API round-trip', () => {
	it('walks, indexes, ranks, and selects chunks using only the entry point', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-repomap-'));
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

		const index = await inspectWorkspace(cwd, { query: 'parseInput' });

		assert.ok(index.files.length >= 2, 'indexed both files');
		assert.ok(index.symbols.some((s) => s.name === 'parseInput'));

		const allFiles = index.files;
		for (const file of allFiles) {
			assert.ok(
				Array.isArray(file.contentLines),
				`${file.path} has contentLines array`,
			);
		}

		const ranked = rankSymbols(index, { query: 'parseInput' });
		assert.equal(ranked[0].name, 'parseInput');

		const terms = queryTokens('parseInput');
		const matches = matchingSymbols(ranked, terms);
		assert.ok(matches.length >= 1, 'found matching symbol');

		const chunks = await buildInspectionChunks(cwd, index, matches);
		assert.ok(chunks.length >= 1, 'built at least one chunk');

		const budget = 2000;
		const selected = selectInspectionChunks(chunks, budget);
		assert.ok(selected.chunks.length >= 1, 'selected chunks within budget');
		assert.ok(selected.usedChars <= budget, 'used chars within budget');
	});

	it('respects ignore options passed to inspectWorkspace', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-repomap-ignore-'));
		await fixture(cwd, 'src/app.mjs', 'export function app() {}');
		await fixture(cwd, '.vendor/lib.mjs', 'export function lib() {}');

		const withIgnore = await inspectWorkspace(cwd, {
			ignorePatterns: [/^\.vendor$/u],
		});
		const withoutIgnore = await inspectWorkspace(cwd);

		const vendorInWith = withIgnore.files.some((f) =>
			f.path.startsWith('.vendor/'),
		);
		const vendorInWithout = withoutIgnore.files.some((f) =>
			f.path.startsWith('.vendor/'),
		);

		assert.equal(vendorInWith, false, '.vendor excluded when pattern given');
		assert.equal(vendorInWithout, true, '.vendor included without pattern');
	});
});

async function fixture(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}
