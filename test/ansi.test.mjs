import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAnsi, stripAnsi } from '../src/ansi.mjs';

describe('ANSI helpers', () => {
	it('wraps text only when color is enabled', () => {
		assert.equal(createAnsi({ isTty: false }).gray('info'), 'info');
		assert.equal(
			createAnsi({ isTty: true }).gray('info'),
			'\u001B[90minfo\u001B[39m',
		);
	});

	it('supports FORCE_COLOR and NO_COLOR policy', () => {
		assert.equal(
			createAnsi({ env: { FORCE_COLOR: '1' }, isTty: false }).green('ok'),
			'\u001B[32mok\u001B[39m',
		);
		assert.equal(
			createAnsi({ env: { FORCE_COLOR: '1', NO_COLOR: '1' }, isTty: true }).red(
				'error',
			),
			'error',
		);
	});

	it('strips ANSI escape codes', () => {
		assert.equal(stripAnsi('\u001B[31merror\u001B[39m'), 'error');
	});
});
