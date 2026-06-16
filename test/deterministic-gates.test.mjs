// test/deterministic-gates.test.mjs — phase 157 tests for deterministicGateOutcome,
// the shared ok-folding decision used by both the default and subagent-stages paths.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deterministicGateOutcome } from '../src/run-pipeline.mjs';

describe('deterministicGateOutcome', () => {
	it('is a no-op when both gates are absent', () => {
		assert.deepEqual(
			deterministicGateOutcome({
				syntaxResult: null,
				smokeResult: null,
				testResult: null,
			}),
			{ syntaxFailed: false, smokeFailed: false },
		);
	});

	it('flags a syntax failure', () => {
		const out = deterministicGateOutcome({
			syntaxResult: { ok: false, failures: [{ path: 'a.mjs' }] },
			smokeResult: null,
			testResult: null,
		});
		assert.equal(out.syntaxFailed, true);
		assert.equal(out.smokeFailed, false);
	});

	it('flags a definitive smoke failure but not an inconclusive one', () => {
		assert.equal(
			deterministicGateOutcome({
				syntaxResult: null,
				smokeResult: { status: 'failed', ok: false },
				testResult: null,
			}).smokeFailed,
			true,
		);
		for (const status of ['skipped', 'timeout', 'ok']) {
			assert.equal(
				deterministicGateOutcome({
					syntaxResult: null,
					smokeResult: { status, ok: status === 'ok' },
					testResult: null,
				}).smokeFailed,
				false,
				`status ${status} must not fail the run`,
			);
		}
	});

	it('a passing test command overrides both gates (heal fixed it)', () => {
		const out = deterministicGateOutcome({
			syntaxResult: { ok: false },
			smokeResult: { status: 'failed' },
			testResult: { ok: true },
		});
		assert.equal(out.syntaxFailed, false);
		assert.equal(out.smokeFailed, false);
	});

	it('a failing test command does not by itself suppress the gates', () => {
		const out = deterministicGateOutcome({
			syntaxResult: { ok: false },
			smokeResult: { status: 'failed' },
			testResult: { ok: false },
		});
		assert.equal(out.syntaxFailed, true);
		assert.equal(out.smokeFailed, true);
	});
});
