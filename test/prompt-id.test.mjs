import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { derivePromptId, promptIdFromFilename } from '../src/prompt-id.mjs';

describe('derivePromptId', () => {
	it('returns an 8-character hex string', () => {
		const id = derivePromptId('hello world');
		assert.equal(id.length, 8);
		assert.match(id, /^[0-9a-f]{8}$/u);
	});

	it('is deterministic for identical input', () => {
		const a = derivePromptId('Build a todo app');
		const b = derivePromptId('Build a todo app');
		assert.equal(a, b);
	});

	it('produces different ids for different inputs', () => {
		const a = derivePromptId('Build a todo app');
		const b = derivePromptId('Build a notes app');
		assert.notEqual(a, b);
	});

	it('handles empty string without throwing', () => {
		const id = derivePromptId('');
		assert.equal(id.length, 8);
	});
});

describe('promptIdFromFilename', () => {
	it('returns the basename without extension', () => {
		assert.equal(promptIdFromFilename('todo-cli.md'), 'todo-cli');
	});

	it('lowercases the result', () => {
		assert.equal(promptIdFromFilename('TodoCLI.md'), 'todocli');
	});

	it('replaces non-alphanumeric chars with hyphens', () => {
		assert.equal(promptIdFromFilename('my prompt v2.txt'), 'my-prompt-v2');
	});

	it('collapses consecutive non-alphanumeric runs to a single hyphen', () => {
		assert.equal(promptIdFromFilename('a__b--c.md'), 'a-b-c');
	});

	it('strips leading and trailing hyphens', () => {
		assert.equal(promptIdFromFilename('--todo--.md'), 'todo');
	});

	it('handles an absolute path by using only the basename', () => {
		assert.equal(
			promptIdFromFilename('/Users/paul/prompts/todo-cli.md'),
			'todo-cli',
		);
	});

	it('handles a nested relative path', () => {
		assert.equal(
			promptIdFromFilename('prompts/notes-api-v3.md'),
			'notes-api-v3',
		);
	});
});
