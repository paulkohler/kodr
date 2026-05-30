import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
	classifyLanguage,
	inspectFile,
	inspectWorkspace,
} from '../src/code-inspector.mjs';

describe('classifyLanguage', () => {
	it('classifies supported source files', () => {
		assert.equal(classifyLanguage('src/app.mjs'), 'javascript');
		assert.equal(classifyLanguage('src/app.ts'), 'typescript');
		assert.equal(classifyLanguage('src/app.py'), 'python');
		assert.equal(classifyLanguage('src/lib.rs'), 'rust');
		assert.equal(classifyLanguage('src/main.go'), 'go');
		assert.equal(classifyLanguage('README.md'), 'unknown');
	});
});

describe('inspectFile', () => {
	it('extracts JavaScript and TypeScript imports and symbols', () => {
		const js = inspectFile(
			'src/app.mjs',
			[
				"import { readFile } from 'node:fs/promises';",
				'export function runPrompt() {}',
				'export class Runner {}',
				"test('runs prompt', () => {});",
			].join('\n'),
		);
		const ts = inspectFile(
			'src/app.ts',
			[
				"import type { Config } from './config';",
				'export const buildConfig = () => ({});',
			].join('\n'),
		);

		assert.equal(js.language, 'javascript');
		assert.deepEqual(
			js.symbols.map((symbol) => [symbol.kind, symbol.name]),
			[
				['function', 'runPrompt'],
				['class', 'Runner'],
				['test', 'runs prompt'],
			],
		);
		assert.equal(
			js.imports[0].specifier,
			"import { readFile } from 'node:fs/promises';",
		);
		assert.equal(ts.language, 'typescript');
		assert.deepEqual(
			ts.symbols.map((symbol) => symbol.name),
			['buildConfig'],
		);
	});

	it('extracts Python imports and top-level symbols', () => {
		const file = inspectFile(
			'app.py',
			[
				'import json',
				'from pathlib import Path',
				'class Runner:',
				'    pass',
				'def run_prompt():',
				'    return True',
				'def test_runner():',
				'    assert run_prompt()',
			].join('\n'),
		);

		assert.equal(file.language, 'python');
		assert.deepEqual(
			file.symbols.map((symbol) => [symbol.kind, symbol.name]),
			[
				['class', 'Runner'],
				['function', 'run_prompt'],
				['test', 'test_runner'],
			],
		);
		assert.deepEqual(
			file.imports.map((item) => item.specifier),
			['import json', 'from pathlib import Path'],
		);
	});

	it('extracts Rust imports and symbols', () => {
		const file = inspectFile(
			'src/lib.rs',
			[
				'use std::fs;',
				'pub struct Runner;',
				'pub enum Mode { Fast }',
				'impl Runner {',
				'    pub fn run(&self) {}',
				'}',
				'#[test]',
				'fn test_runner() {}',
			].join('\n'),
		);

		assert.equal(file.language, 'rust');
		assert.deepEqual(
			file.symbols.map((symbol) => [symbol.kind, symbol.name]),
			[
				['struct', 'Runner'],
				['enum', 'Mode'],
				['impl', 'Runner'],
				['function', 'run'],
				['test', 'test_runner'],
			],
		);
		assert.equal(file.imports[0].specifier, 'use std::fs;');
	});

	it('extracts Go imports, functions, types, and tests', () => {
		const file = inspectFile(
			'main_test.go',
			[
				'package main',
				'import "testing"',
				'type Runner struct{}',
				'func RunPrompt() {}',
				'func TestRunPrompt(t *testing.T) {}',
			].join('\n'),
		);

		assert.equal(file.language, 'go');
		assert.deepEqual(
			file.symbols.map((symbol) => [symbol.kind, symbol.name]),
			[
				['type', 'Runner'],
				['function', 'RunPrompt'],
				['test', 'TestRunPrompt'],
			],
		);
		assert.equal(file.imports[0].specifier, 'import "testing"');
	});
});

describe('inspectWorkspace', () => {
	it('builds a deterministic multi-language symbol index and references', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-inspect-'));
		await writeFixture(
			cwd,
			'src/app.mjs',
			[
				"import { helper } from './helper.mjs';",
				'export function runPrompt() {',
				'  return helper();',
				'}',
			].join('\n'),
		);
		await writeFixture(
			cwd,
			'src/helper.py',
			[
				'def helper():',
				'    return "ok"',
				'def test_helper():',
				'    assert helper() == "ok"',
			].join('\n'),
		);
		await writeFixture(cwd, 'src/lib.rs', 'pub fn run_prompt() {}\n');
		await writeFixture(cwd, 'src/main.go', 'package main\nfunc main() {}\n');
		await writeFixture(cwd, 'README.md', '# ignored\n');

		const index = await inspectWorkspace(cwd, { symbol: 'helper' });

		assert.deepEqual(index.languages, {
			go: 1,
			javascript: 1,
			python: 1,
			rust: 1,
		});
		assert.deepEqual(
			index.files.map((file) => file.path),
			['src/app.mjs', 'src/helper.py', 'src/lib.rs', 'src/main.go'],
		);
		assert.equal(
			index.symbols.some((item) => item.name === 'runPrompt'),
			true,
		);
		assert.equal(
			index.symbols.some((item) => item.name === 'helper'),
			true,
		);
		assert.deepEqual(
			index.references.map(
				(reference) => `${reference.path}:${reference.line}`,
			),
			['src/app.mjs:1', 'src/app.mjs:3', 'src/helper.py:1', 'src/helper.py:4'],
		);
		assert.ok(typeof index.totalFiles === 'number', 'totalFiles is a number');
		assert.ok(
			typeof index.totalSymbols === 'number',
			'totalSymbols is a number',
		);
	});
});

async function writeFixture(cwd, path, content) {
	const absolute = join(cwd, path);
	await mkdir(dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}
