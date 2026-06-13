import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recommendModel, renderRouteCli } from '../src/routing.mjs';

const report = (models) => ({ models });

describe('recommendModel', () => {
	it('recommends the highest ok-rate model with enough runs', () => {
		const rec = recommendModel(
			report({
				a: { runs: 21, ok: 14, okRate: 14 / 21 },
				b: { runs: 30, ok: 8, okRate: 8 / 30 },
			}),
			{ minRuns: 3 },
		);
		assert.equal(rec.recommended, 'a');
		assert.equal(rec.ranked[0].model, 'a');
		assert.equal(rec.eligibleCount, 2);
	});

	it('filters out models below minRuns and the "unknown" bucket', () => {
		const rec = recommendModel(
			report({
				lucky: { runs: 1, ok: 1, okRate: 1 },
				solid: { runs: 10, ok: 6, okRate: 0.6 },
				unknown: { runs: 99, ok: 99, okRate: 1 },
			}),
			{ minRuns: 3 },
		);
		assert.equal(rec.recommended, 'solid');
		assert.equal(rec.eligibleCount, 1);
	});

	it('returns null recommendation when no model meets minRuns', () => {
		const rec = recommendModel(report({ a: { runs: 2, ok: 2, okRate: 1 } }), {
			minRuns: 3,
		});
		assert.equal(rec.recommended, null);
		assert.equal(rec.totalModels, 1);
	});

	it('breaks ok-rate ties by run count', () => {
		const rec = recommendModel(
			report({
				few: { runs: 4, ok: 4, okRate: 1 },
				many: { runs: 20, ok: 20, okRate: 1 },
			}),
			{ minRuns: 3 },
		);
		assert.equal(rec.recommended, 'many');
	});
});

describe('renderRouteCli', () => {
	it('renders the recommendation and candidate list', () => {
		const out = renderRouteCli(
			recommendModel(
				report({
					a: { runs: 21, ok: 14, okRate: 14 / 21 },
					b: { runs: 30, ok: 8, okRate: 8 / 30 },
				}),
				{ minRuns: 3 },
			),
		);
		assert.match(out, /Recommended edit model/u);
		assert.match(out, /→ a/u);
		assert.match(out, /14\/21 ok \(67%\)/u);
	});

	it('renders a helpful message when nothing qualifies', () => {
		const out = renderRouteCli(
			recommendModel(report({ a: { runs: 1, ok: 1, okRate: 1 } }), {
				minRuns: 3,
			}),
		);
		assert.match(out, /No model has at least 3 runs/u);
	});

	it('notes when the recommendation was applied', () => {
		const out = renderRouteCli(
			recommendModel(report({ a: { runs: 5, ok: 5, okRate: 1 } }), {
				minRuns: 3,
			}),
			{ applied: true },
		);
		assert.match(out, /applied: model set to a/u);
	});
});
