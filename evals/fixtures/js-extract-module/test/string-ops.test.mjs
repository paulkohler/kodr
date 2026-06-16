import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatName, formatTitle } from '../src/string-ops.mjs';
import { toTitleCase } from '../src/utils.mjs';

describe('formatName', () => {
	it('trims and title-cases the input', () => {
		assert.equal(formatName('  hello world  '), 'Hello World');
	});
	it('returns empty string for non-string input', () => {
		assert.equal(formatName(null), '');
	});
});

describe('formatTitle', () => {
	it('delegates to toTitleCase from utils', () => {
		// formatTitle and toTitleCase must produce the same output — they share
		// the same logic via the extracted utility.
		assert.equal(formatTitle('foo bar baz'), toTitleCase('foo bar baz'));
	});
});

describe('toTitleCase (extracted utility)', () => {
	it('title-cases a lowercase string', () => {
		assert.equal(toTitleCase('hello world'), 'Hello World');
	});
	it('trims whitespace', () => {
		assert.equal(toTitleCase('  foo bar  '), 'Foo Bar');
	});
	it('handles single word', () => {
		assert.equal(toTitleCase('node'), 'Node');
	});
});
