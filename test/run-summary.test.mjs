// Unit tests for renderRunSummary — Phase 242 additions:
//   repair_context_overflow stop reason, healContextOverflowRetries annotation,
//   staged.runawayRetries annotation, and regression guard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderRunSummary } from '../src/run-summary.mjs';

// Minimal result object that satisfies renderRunSummary without triggering any
// proposal/response/test/heal rendering other than what each test specifically sets.
function baseResult(overrides = {}) {
	return {
		ok: true,
		model: 'test-model',
		usage: null,
		runDir: '/tmp/run',
		responsePath: '/tmp/run/response.txt',
		...overrides,
	};
}

describe('renderRunSummary Phase 242', () => {
	// Test A: repair_context_overflow stop reason renders targeted message
	it('renders targeted message for repair_context_overflow stop reason', () => {
		const result = baseResult({
			healingResult: {
				healed: false,
				stopReason: 'repair_context_overflow',
				repairs: [],
			},
		});
		const output = renderRunSummary(result);
		assert.match(output, /repair_context_overflow/u);
		assert.match(output, /HTTP 400/u);
		assert.match(output, /LM Studio/u);
	});

	// Test B: healContextOverflowRetries > 0 annotates the repair result line
	it('annotates repair line when healContextOverflowRetries > 0', () => {
		const result = baseResult({
			healingResult: {
				healed: true,
				stopReason: 'healed',
				repairs: [],
				healContextOverflowRetries: 2,
			},
		});
		const output = renderRunSummary(result);
		assert.match(output, /2 repair turn\(s\) hit HTTP-400 context overflow/u);
		assert.match(output, /LM Studio KV-cache bleed/u);
	});

	// Test C: staged.runawayRetries > 0 renders annotation
	it('renders staged runaway annotation when runawayRetries > 0', () => {
		const result = baseResult({
			staged: { runawayRetries: 1 },
		});
		const output = renderRunSummary(result);
		assert.match(output, /1 staged implement turn\(s\) hit reasoning runaway/u);
		assert.match(output, /capped max_tokens/u);
	});

	// Test D: staged.runawayRetries === 0 or absent does NOT include runaway note
	it('does not render staged runaway annotation when runawayRetries is 0 or absent', () => {
		const resultZero = baseResult({ staged: { runawayRetries: 0 } });
		const resultAbsent = baseResult({});
		const resultNoStaged = baseResult({ staged: undefined });

		for (const result of [resultZero, resultAbsent, resultNoStaged]) {
			const output = renderRunSummary(result);
			assert.doesNotMatch(
				output,
				/staged implement turn\(s\) hit reasoning runaway/u,
			);
		}
	});
});
