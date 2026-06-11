import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, VERSION } from '../src/cli.mjs';

describe('parseArgs', () => {
	it('recognises --version flag', () => {
		const result = parseArgs(['--version']);
		assert.equal(result.version, true);
	});

	it('--version value matches the exported VERSION constant', () => {
		const result = parseArgs(['--version']);
		assert.equal(result.versionString, VERSION);
	});

	it('--help still works alongside --version', () => {
		const result = parseArgs(['--help', '--version']);
		assert.equal(result.help, true);
		assert.equal(result.version, true);
	});
});
