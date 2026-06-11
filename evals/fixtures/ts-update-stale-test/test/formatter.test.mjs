import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { format } from '../src/formatter.ts';

describe('format', () => {
	it('trims and lowercases the input', () => {
		assert.equal(format(' Hello '), 'hello');
	});

	it('handles already-trimmed input', () => {
		assert.equal(format('world'), 'world');
	});
});
