import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/app.mjs';

describe('inspect command', () => {
	it('prints a structural index as JSON', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-command-'));
		await writeFixture(
			cwd,
			'src/app.go',
			'package main\nfunc RunPrompt() {}\nfunc TestRunPrompt() { RunPrompt() }\n',
		);
		const stdout = capture();
		const stderr = capture();

		const result = await main(['inspect', '--symbol', 'RunPrompt', '--json'], {
			cwd,
			env: {},
			stderr,
			stdout,
		});
		const body = JSON.parse(stdout.output);

		assert.equal(result.ok, true);
		assert.equal(result.command, 'inspect');
		assert.equal(body.files[0].language, 'go');
		assert.equal(
			body.symbols.some((symbol) => symbol.name === 'RunPrompt'),
			true,
		);
		assert.equal(body.references.length, 2);
		assert.equal(stderr.output, '');
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

async function writeFixture(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}
