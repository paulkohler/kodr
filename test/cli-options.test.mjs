// test/cli-options.test.mjs — unit tests for workspaceContextOptions (phase 250).
// Covers the resolvedPrompt precedence matrix added to fix the --prompt-file
// context-signal loss bug.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { workspaceContextOptions } from '../src/cli/options.mjs';

const CWD = '/tmp/test-cwd';

describe('workspaceContextOptions', () => {
	it('resolved prompt wins over empty flag (--prompt-file case)', () => {
		const result = workspaceContextOptions(
			{ prompt: '' },
			CWD,
			'create app.mjs',
		);
		assert.equal(result.taskPrompt, 'create app.mjs');
	});

	it('two-arg back-compat: flag value used when resolvedPrompt is absent', () => {
		const result = workspaceContextOptions({ prompt: 'flag text' }, CWD);
		assert.equal(result.taskPrompt, 'flag text');
	});

	it('resolved prompt takes precedence over flag when both present', () => {
		const result = workspaceContextOptions(
			{ prompt: 'flag text' },
			CWD,
			'file text',
		);
		assert.equal(result.taskPrompt, 'file text');
	});

	it('explicit empty resolvedPrompt is respected (not fallen-through via ??)', () => {
		const result = workspaceContextOptions({ prompt: 'flag text' }, CWD, '');
		assert.equal(result.taskPrompt, '');
	});

	it('no prompt at all yields empty string', () => {
		const result = workspaceContextOptions({}, CWD);
		assert.equal(result.taskPrompt, '');
	});
});
