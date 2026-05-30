import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { main } from '../src/app.mjs';

describe('registry command', () => {
	it('returns an array of inspector entries with name, languages, available', async () => {
		const stdout = capture();
		const result = await main(['registry', '--json'], {
			cwd: process.cwd(),
			env: {},
			stderr: capture(),
			stdout,
		});
		const entries = JSON.parse(stdout.output);
		assert.equal(result.ok, true);
		assert.equal(result.command, 'registry');
		assert.ok(Array.isArray(entries));
		assert.ok(entries.length > 0);
		for (const entry of entries) {
			assert.ok(typeof entry.name === 'string');
			assert.ok(Array.isArray(entry.languages));
			assert.ok(typeof entry.available === 'boolean');
		}
	});
});

function capture() {
	return {
		output: '',
		write(chunk) {
			this.output += chunk;
		},
	};
}
