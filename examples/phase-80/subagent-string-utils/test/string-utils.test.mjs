// test/string-utils.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert/strict';
import { slugifyTitle, wordCount } from '../src/string-utils.mjs';

// Tests for slugifyTitle ----------------------------------------------------
test('slugifyTitle normal title', () => {
  assert.strictEqual(slugifyTitle('Hello World!'), 'hello-world');
});

test('slugifyTitle with punctuation and spaces', () => {
  assert.strictEqual(
    slugifyTitle('  This---is   a TEST!!! '),
    'this-is-a-test'
  );
});

test('slugifyTitle empty string', () => {
  assert.strictEqual(slugifyTitle(''), '');
});

test('slugifyTitle whitespace only', () => {
  assert.strictEqual(slugifyTitle('   \t\n'), '');
});

test('slugifyTitle leading/trailing hyphens', () => {
  assert.strictEqual(slugifyTitle('-foo-bar-'), 'foo-bar');
});

test('slugifyTitle non-string throws TypeError', () => {
  assert.throws(() => slugifyTitle(123), TypeError);
  assert.throws(() => slugifyTitle(null), TypeError);
  assert.throws(() => slugifyTitle(undefined), TypeError);
});

// Tests for wordCount ------------------------------------------------------
test('wordCount basic sentence', () => {
  assert.strictEqual(wordCount('Hello world'), 2);
});

test('wordCount multiple spaces and tabs', () => {
  assert.strictEqual(wordCount('Hello   world\t\nfoo'), 3);
});

test('wordCount empty string', () => {
  assert.strictEqual(wordCount(''), 0);
});

test('wordCount whitespace only', () => {
  assert.strictEqual(wordCount('   \t  '), 0);
});

test('wordCount punctuation attached', () => {
  assert.strictEqual(wordCount('Hello, world!'), 2);
});

test('wordCount non-string throws TypeError', () => {
  assert.throws(() => wordCount(42), TypeError);
  assert.throws(() => wordCount({}), TypeError);
});