import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rankSymbols } from '../src/repomap/index.mjs';

describe('rankSymbols', () => {
	it('orders symbols by deterministic query, reference, kind, and path score', () => {
		const index = {
			files: [
				file('src/alpha.mjs', [
					'export function targetAlpha() {}',
					'targetAlpha();',
					'targetAlpha();',
				]),
				file('src/beta.mjs', [
					'export function targetBeta() {}',
					'targetBeta();',
				]),
				file('src/state.mjs', ['export const targetState = {};']),
			],
			symbols: [
				symbol('src/beta.mjs', 'function', 'targetBeta'),
				symbol('src/state.mjs', 'variable', 'targetState'),
				symbol('src/alpha.mjs', 'function', 'targetAlpha'),
			],
		};

		const ranked = rankSymbols(index, { query: 'change target function' });

		assert.deepEqual(
			ranked.map((item) => item.name),
			['targetAlpha', 'targetBeta', 'targetState'],
		);
		assert.equal(ranked[0].rank.queryScore, 80);
		assert.equal(ranked[0].rank.referenceCount, 3);
		assert.equal(ranked[0].rank.kindWeight, 5);
		assert.equal(ranked[0].rank.score, 100);
	});

	it('breaks equal scores by path, line, and name', () => {
		const index = {
			files: [
				file('b.mjs', ['export function sameB() {}']),
				file('a.mjs', ['export function sameA() {}']),
			],
			symbols: [
				symbol('b.mjs', 'function', 'sameB'),
				symbol('a.mjs', 'function', 'sameA'),
			],
		};

		assert.deepEqual(
			rankSymbols(index).map((item) => item.path),
			['a.mjs', 'b.mjs'],
		);
	});
});

function file(path, lines) {
	return {
		contentLines: lines.map((text, index) => ({ number: index + 1, text })),
		imports: [],
		language: 'javascript',
		lineCount: lines.length,
		path,
		symbols: [],
	};
}

function symbol(path, kind, name) {
	return {
		kind,
		language: 'javascript',
		lineEnd: 1,
		lineStart: 1,
		name,
		path,
	};
}
