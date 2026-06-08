import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/app.mjs';

describe('inspect command', () => {
	it('filters files by --languages flag', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-languages-'));
		await writeFixtureAt(cwd, 'src/main.go', 'package main\nfunc Run() {}\n');
		await writeFixtureAt(cwd, 'src/app.py', 'def hello(): pass\n');
		const stdout = capture();

		const result = await main(['inspect', '--languages', 'go', '--json'], {
			cwd,
			env: {},
			stderr: capture(),
			stdout,
		});
		const body = JSON.parse(stdout.output);

		assert.equal(result.ok, true);
		assert.equal(
			body.files.every((f) => f.language === 'go'),
			true,
		);
		assert.equal(
			body.files.some((f) => f.language === 'python'),
			false,
		);
	});

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

	it('filters inspection to one file with --file', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-file-'));
		await writeFixture(cwd, 'src/app.mjs', 'export function app() {}\n');
		await writeFixture(cwd, 'src/other.mjs', 'export function other() {}\n');
		const stdout = capture();

		const result = await main(['inspect', '--file', 'src/app.mjs', '--json'], {
			cwd,
			env: {},
			stderr: capture(),
			stdout,
		});
		const body = JSON.parse(stdout.output);

		assert.equal(result.ok, true);
		assert.deepEqual(
			body.files.map((file) => file.path),
			['src/app.mjs'],
		);
		assert.deepEqual(
			body.symbols.map((symbol) => symbol.name),
			['app'],
		);
	});

	it('rejects inspect --file path traversal', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-file-jail-'));
		await assert.rejects(
			() =>
				main(['inspect', '--file', '../../etc/passwd'], {
					cwd,
					env: {},
					stderr: capture(),
					stdout: capture(),
				}),
			/Parent path segments/u,
		);
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

async function writeFixtureAt(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}

async function writeFixture(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}
