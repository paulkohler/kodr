import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { trimName } from '../tests/utils.mjs';

describe('trimName', () => {
	it('strips surrounding whitespace', () => {
		assert.equal(trimName(' hello '), 'hello');
		assert.equal(trimName('\tworld\n'), 'world');
	});

	it('leaves non-whitespace unchanged', () => {
		assert.equal(trimName('ok'), 'ok');
	});
});
