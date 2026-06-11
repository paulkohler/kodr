import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	checkBaselineFails,
	directoriesIdentical,
	probeToolchain,
	recordResults,
	runWorkspaceCase,
	slugify,
	stageFixture,
} from '../src/eval-runner.mjs';
import { EvalError, loadEvalSuite } from '../src/eval.mjs';
import { CliError, main, parseArgs, runPrompt } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
	it('lowercases and replaces non-alphanumeric runs with -', () => {
		assert.equal(slugify('Brownfield Edit Suite'), 'brownfield-edit-suite');
		assert.equal(slugify('qwen/qwen3.6-35b'), 'qwen-qwen3-6-35b');
	});

	it('strips leading and trailing dashes', () => {
		assert.equal(slugify('  hello world  '), 'hello-world');
	});
});

// ---------------------------------------------------------------------------
// loadEvalSuite — workspace case schema
// ---------------------------------------------------------------------------

describe('loadEvalSuite workspace schema', () => {
	it('validates a minimal workspace case', () => {
		const suite = loadEvalSuite(
			JSON.stringify({
				name: 'ws',
				cases: [
					{
						id: 'fix-bug',
						fixture: 'fixtures/fix-bug',
						test: 'node --test',
						prompt: 'Fix the bug.',
						assertions: [{ type: 'tests_pass', command: 'node --test' }],
					},
				],
			}),
		);
		assert.equal(suite.cases[0].fixture, 'fixtures/fix-bug');
		assert.equal(suite.cases[0].test, 'node --test');
		assert.equal(suite.cases[0].expectFailingBaseline, false);
		assert.deepEqual(suite.cases[0].requires, []);
	});

	it('round-trips requires and expectFailingBaseline', () => {
		const suite = loadEvalSuite(
			JSON.stringify({
				name: 'ws',
				cases: [
					{
						id: 'fix-py',
						fixture: 'fixtures/fix-py',
						test: 'python3 -m unittest discover',
						requires: ['python3'],
						expectFailingBaseline: true,
						prompt: 'Fix it.',
						assertions: [],
					},
				],
			}),
		);
		const c = suite.cases[0];
		assert.deepEqual(c.requires, ['python3']);
		assert.equal(c.expectFailingBaseline, true);
	});

	it('rejects workspace-only assertion type in proposal case', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						name: 'x',
						cases: [
							{
								id: 'bad-case',
								prompt: 'Do something',
								assertions: [{ type: 'file_modified', path: 'src/foo.mjs' }],
							},
						],
					}),
				),
			(err) => {
				assert.ok(err instanceof EvalError, 'should be EvalError');
				assert.ok(
					err.message.includes('bad-case'),
					`message should name the case: ${err.message}`,
				);
				assert.ok(
					err.message.includes('file_modified'),
					`message should name the assertion type: ${err.message}`,
				);
				return true;
			},
		);
	});

	it('validates file_modified assertion requires path', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						name: 'x',
						cases: [
							{
								id: 'c',
								fixture: 'fixtures/f',
								test: 'node --test',
								prompt: 'p',
								assertions: [{ type: 'file_modified' }],
							},
						],
					}),
				),
			EvalError,
		);
	});

	it('validates files_absent assertion requires paths array', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						name: 'x',
						cases: [
							{
								id: 'c',
								fixture: 'fixtures/f',
								test: 'node --test',
								prompt: 'p',
								assertions: [{ type: 'files_absent', paths: [] }],
							},
						],
					}),
				),
			EvalError,
		);
	});

	it('workspace case requires test field', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						name: 'x',
						cases: [
							{
								id: 'c',
								fixture: 'fixtures/f',
								prompt: 'p',
								assertions: [],
							},
						],
					}),
				),
			EvalError,
		);
	});
});

// ---------------------------------------------------------------------------
// stageFixture — copies without .kodr/, records baseline hashes
// ---------------------------------------------------------------------------

describe('stageFixture', () => {
	it('copies files from fixture dir into a fresh temp dir', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fixture-'));
		await mkdir(join(fixtureDir, 'src'), { recursive: true });
		await writeFile(
			join(fixtureDir, 'src', 'index.mjs'),
			'export const x = 1;\n',
		);
		await writeFile(join(fixtureDir, 'README.md'), '# readme\n');

		const { stagedDir, baselineHashes } = await stageFixture(fixtureDir);
		try {
			const content = await readFile(
				join(stagedDir, 'src', 'index.mjs'),
				'utf8',
			);
			assert.equal(content, 'export const x = 1;\n');
			assert.ok(
				baselineHashes.has('src/index.mjs'),
				'baseline has src/index.mjs',
			);
			assert.ok(baselineHashes.has('README.md'), 'baseline has README.md');
		} finally {
			const { rm } = await import('node:fs/promises');
			await rm(stagedDir, { recursive: true, force: true });
			await rm(fixtureDir, { recursive: true, force: true });
		}
	});

	it('skips .kodr/ directory in the fixture', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fixture-'));
		await mkdir(join(fixtureDir, '.kodr', 'runs'), { recursive: true });
		await writeFile(join(fixtureDir, '.kodr', 'last-run.md'), '# run\n');
		await writeFile(join(fixtureDir, 'code.mjs'), 'export const y = 2;\n');

		const { stagedDir, baselineHashes } = await stageFixture(fixtureDir);
		try {
			// .kodr should not be in the staged dir
			let kodrExists = false;
			try {
				await stat(join(stagedDir, '.kodr'));
				kodrExists = true;
			} catch {
				// expected
			}
			assert.equal(kodrExists, false, '.kodr should not be staged');
			assert.ok(baselineHashes.has('code.mjs'), 'code.mjs in baseline');
			assert.ok(
				!baselineHashes.has('.kodr/last-run.md'),
				'.kodr not in baseline',
			);
		} finally {
			const { rm } = await import('node:fs/promises');
			await rm(stagedDir, { recursive: true, force: true });
			await rm(fixtureDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// directoriesIdentical — mutation guard
// ---------------------------------------------------------------------------

describe('directoriesIdentical', () => {
	it('returns true for identical dirs', async () => {
		const a = await mkdtemp(join(tmpdir(), 'kodr-dir-a-'));
		const b = await mkdtemp(join(tmpdir(), 'kodr-dir-b-'));
		await writeFile(join(a, 'f.txt'), 'hello');
		await writeFile(join(b, 'f.txt'), 'hello');
		const { rm } = await import('node:fs/promises');
		try {
			assert.equal(await directoriesIdentical(a, b), true);
		} finally {
			await rm(a, { recursive: true, force: true });
			await rm(b, { recursive: true, force: true });
		}
	});

	it('returns false when files differ', async () => {
		const a = await mkdtemp(join(tmpdir(), 'kodr-dir-a-'));
		const b = await mkdtemp(join(tmpdir(), 'kodr-dir-b-'));
		await writeFile(join(a, 'f.txt'), 'hello');
		await writeFile(join(b, 'f.txt'), 'world');
		const { rm } = await import('node:fs/promises');
		try {
			assert.equal(await directoriesIdentical(a, b), false);
		} finally {
			await rm(a, { recursive: true, force: true });
			await rm(b, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// probeToolchain
// ---------------------------------------------------------------------------

describe('probeToolchain', () => {
	it('returns null when requires is empty', async () => {
		assert.equal(await probeToolchain([]), null);
	});

	it('returns null when node is available', async () => {
		assert.equal(await probeToolchain(['node']), null);
	});

	it('returns the missing binary name when it does not exist', async () => {
		const missing = await probeToolchain(['__nonexistent_bin_xyz__']);
		assert.equal(missing, '__nonexistent_bin_xyz__');
	});
});

// ---------------------------------------------------------------------------
// workspace assertion types (via runWorkspaceAssertion)
// ---------------------------------------------------------------------------

import { runWorkspaceAssertion } from '../src/eval.mjs';

describe('runWorkspaceAssertion — file_modified', () => {
	it('passes when file hash differs from baseline', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			await writeFile(join(dir, 'x.mjs'), 'export const x = 2;');
			const baseline = new Map([['x.mjs', 'deadbeef']]);
			const result = await runWorkspaceAssertion(
				{ type: 'file_modified', path: 'x.mjs' },
				dir,
				baseline,
			);
			assert.equal(result.ok, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails when hash is unchanged', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		const content = 'export const x = 1;';
		try {
			await writeFile(join(dir, 'x.mjs'), content);
			const { hashFile } = await import('../src/eval.mjs');
			const hash = await hashFile(join(dir, 'x.mjs'));
			const baseline = new Map([['x.mjs', hash]]);
			const result = await runWorkspaceAssertion(
				{ type: 'file_modified', path: 'x.mjs' },
				dir,
				baseline,
			);
			assert.equal(result.ok, false);
			assert.ok(result.detail.includes('not modified'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails when file does not exist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			const baseline = new Map([['missing.mjs', 'abc']]);
			const result = await runWorkspaceAssertion(
				{ type: 'file_modified', path: 'missing.mjs' },
				dir,
				baseline,
			);
			assert.equal(result.ok, false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('runWorkspaceAssertion — file_unchanged', () => {
	it('passes when hash matches baseline', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		const content = 'same content';
		try {
			await writeFile(join(dir, 'y.mjs'), content);
			const { hashFile } = await import('../src/eval.mjs');
			const hash = await hashFile(join(dir, 'y.mjs'));
			const baseline = new Map([['y.mjs', hash]]);
			const result = await runWorkspaceAssertion(
				{ type: 'file_unchanged', path: 'y.mjs' },
				dir,
				baseline,
			);
			assert.equal(result.ok, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails when hash differs from baseline', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			await writeFile(join(dir, 'y.mjs'), 'new content');
			const baseline = new Map([['y.mjs', 'oldhash']]);
			const result = await runWorkspaceAssertion(
				{ type: 'file_unchanged', path: 'y.mjs' },
				dir,
				baseline,
			);
			assert.equal(result.ok, false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('runWorkspaceAssertion — files_absent', () => {
	it('passes when all named paths are absent', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			const result = await runWorkspaceAssertion(
				{ type: 'files_absent', paths: ['utils.mjs', 'sibling.mjs'] },
				dir,
				new Map(),
			);
			assert.equal(result.ok, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails when a path exists', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			await writeFile(join(dir, 'sibling.mjs'), 'bad');
			const result = await runWorkspaceAssertion(
				{ type: 'files_absent', paths: ['utils.mjs', 'sibling.mjs'] },
				dir,
				new Map(),
			);
			assert.equal(result.ok, false);
			assert.ok(result.detail.includes('sibling.mjs'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('runWorkspaceAssertion — content_absent', () => {
	it('passes when the pattern is not found in the file', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			await writeFile(join(dir, 'src.mjs'), 'export function newName() {}');
			const result = await runWorkspaceAssertion(
				{ type: 'content_absent', path: 'src.mjs', pattern: '\\boldName\\b' },
				dir,
				new Map(),
			);
			assert.equal(result.ok, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('fails when the pattern is still present', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-ws-'));
		const { rm } = await import('node:fs/promises');
		try {
			await writeFile(join(dir, 'src.mjs'), 'export function oldName() {}');
			const result = await runWorkspaceAssertion(
				{ type: 'content_absent', path: 'src.mjs', pattern: '\\boldName\\b' },
				dir,
				new Map(),
			);
			assert.equal(result.ok, false);
			assert.ok(result.detail.includes('still present'));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Full workspace case loop via startFakeModelServer
// ---------------------------------------------------------------------------

describe('runWorkspaceCase — scripted proposals', () => {
	async function makeFixture(files) {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-eval-fix-'));
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(dir, rel);
			await mkdir(join(dir, rel, '..'), { recursive: true });
			await writeFile(abs, content);
		}
		return dir;
	}

	function makeOptions(baseUrl) {
		const opts = parseArgs(['run', '-p', 'x', '--model', 'fake-model'], {
			BASE_URL: baseUrl,
		});
		return {
			...opts,
			yes: true,
			dryRun: false,
			stream: false,
			_runPrompt: runPrompt,
		};
	}

	it('tests_pass + file_modified + files_absent all pass when model fixes the right file', async () => {
		// Fixture: tests/utils.mjs has a bug; test expects trimName to trim
		const fixtureDir = await makeFixture({
			'tests/utils.mjs':
				'export function trimName(s) { return s.toUpperCase(); }\n',
			'test/utils.test.mjs':
				[
					"import assert from 'node:assert/strict';",
					"import { it } from 'node:test';",
					"import { trimName } from '../tests/utils.mjs';",
					"it('trims', () => { assert.equal(trimName(' x '), 'x'); });",
				].join('\n') + '\n',
		});
		const { rm } = await import('node:fs/promises');

		// Scripted response: model fixes tests/utils.mjs correctly
		const fixedContent = 'export function trimName(s) { return s.trim(); }\n';
		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [{ path: 'tests/utils.mjs', content: fixedContent }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: fakeResponse, role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-eval-run-'));
		try {
			const evalCase = {
				id: 'fix-named-path',
				fixture: fixtureDir,
				test: 'node --test',
				requires: [],
				expectFailingBaseline: false,
				heal: false,
				prompt: 'Fix tests/utils.mjs so trimName trims whitespace.',
				assertions: [
					{ type: 'tests_pass', command: 'node --test' },
					{ type: 'file_modified', path: 'tests/utils.mjs' },
					{ type: 'files_absent', paths: ['utils.mjs'] },
				],
			};

			const options = makeOptions(server.baseUrl);
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);

			assert.equal(result.status, 'ran');
			assert.equal(
				result.ok,
				true,
				`Expected all assertions to pass, got: ${JSON.stringify(result.assertions)}`,
			);
		} finally {
			await server.close();
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});

	it('file_modified and files_absent fail when model creates a root-level sibling instead', async () => {
		const fixtureDir = await makeFixture({
			'tests/utils.mjs':
				'export function trimName(s) { return s.toUpperCase(); }\n',
			'test/utils.test.mjs':
				[
					"import assert from 'node:assert/strict';",
					"import { it } from 'node:test';",
					"import { trimName } from '../tests/utils.mjs';",
					"it('trims', () => { assert.equal(trimName(' x '), 'x'); });",
				].join('\n') + '\n',
		});
		const { rm } = await import('node:fs/promises');

		// Scripted response: model creates utils.mjs at root (wrong path)
		const wrongContent = 'export function trimName(s) { return s.trim(); }\n';
		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [{ path: 'utils.mjs', content: wrongContent }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: fakeResponse, role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-eval-run-'));
		try {
			const evalCase = {
				id: 'fix-sibling-test',
				fixture: fixtureDir,
				test: 'node --test',
				requires: [],
				expectFailingBaseline: false,
				heal: false,
				prompt: 'Fix tests/utils.mjs.',
				assertions: [
					{ type: 'file_modified', path: 'tests/utils.mjs' },
					{ type: 'files_absent', paths: ['utils.mjs'] },
				],
			};

			const options = makeOptions(server.baseUrl);
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);

			assert.equal(result.status, 'ran');
			const fileModified = result.assertions.find(
				(a) => a.type === 'file_modified',
			);
			const filesAbsent = result.assertions.find(
				(a) => a.type === 'files_absent',
			);
			assert.equal(
				fileModified.ok,
				false,
				'file_modified should fail — tests/utils.mjs was not edited',
			);
			assert.equal(
				filesAbsent.ok,
				false,
				'files_absent should fail — utils.mjs was created at root',
			);
		} finally {
			await server.close();
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});

	it('workspace tests_pass fails when model returns a no-write OK envelope', async () => {
		const fixtureDir = await makeFixture({
			'test/x.test.mjs':
				[
					"import assert from 'node:assert/strict';",
					"import { it } from 'node:test';",
					"it('always fails', () => { assert.equal(1, 2); });",
				].join('\n') + '\n',
		});
		const { rm } = await import('node:fs/promises');

		// Scripted response: model returns OK with zero files (no progress)
		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: fakeResponse, role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});

		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-eval-run-'));
		try {
			const evalCase = {
				id: 'noop-envelope',
				fixture: fixtureDir,
				test: 'node --test',
				requires: [],
				expectFailingBaseline: false,
				heal: false,
				prompt: 'Fix the always-failing test.',
				assertions: [{ type: 'tests_pass', command: 'node --test' }],
			};

			const options = makeOptions(server.baseUrl);
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);

			const testsPass = result.assertions.find((a) => a.type === 'tests_pass');
			assert.equal(
				testsPass.ok,
				false,
				'tests_pass should fail when model made no changes',
			);
		} finally {
			await server.close();
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Baseline guard
// ---------------------------------------------------------------------------

describe('checkBaselineFails', () => {
	it('returns true when the test command fails', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-baseline-'));
		const { rm } = await import('node:fs/promises');
		await mkdir(join(dir, 'test'), { recursive: true });
		await writeFile(
			join(dir, 'test', 'fail.test.mjs'),
			"import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('fails', () => { assert.equal(1, 2); });\n",
		);
		try {
			const result = await checkBaselineFails(dir, 'node --test', 30000);
			assert.equal(result, true);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it('returns false (fixture-invalid) when tests already pass', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-baseline-'));
		const { rm } = await import('node:fs/promises');
		await mkdir(join(dir, 'test'), { recursive: true });
		await writeFile(
			join(dir, 'test', 'pass.test.mjs'),
			"import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('passes', () => { assert.ok(true); });\n",
		);
		try {
			const result = await checkBaselineFails(dir, 'node --test', 30000);
			assert.equal(result, false);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// fixture-invalid status
// ---------------------------------------------------------------------------

describe('runWorkspaceCase — fixture-invalid', () => {
	it('reports fixture-invalid when baseline test already passes', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fix-'));
		const { rm } = await import('node:fs/promises');
		await mkdir(join(fixtureDir, 'test'), { recursive: true });
		await writeFile(
			join(fixtureDir, 'test', 'ok.test.mjs'),
			"import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('passes', () => { assert.ok(true); });\n",
		);
		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-run-'));
		try {
			const evalCase = {
				id: 'always-passes',
				fixture: fixtureDir,
				test: 'node --test',
				requires: [],
				expectFailingBaseline: true,
				heal: false,
				prompt: 'Fix the test.',
				assertions: [],
			};
			const opts = parseArgs(['run', '-p', 'x', '--model', 'fake'], {
				BASE_URL: 'http://localhost:1',
			});
			const options = {
				...opts,
				yes: true,
				dryRun: false,
				_runPrompt: runPrompt,
			};
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);
			assert.equal(result.status, 'fixture-invalid');
			assert.ok(result.reason.includes('fixture'));
		} finally {
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Skip gating
// ---------------------------------------------------------------------------

describe('runWorkspaceCase — skip', () => {
	it('returns skipped when a required binary is missing', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fix-'));
		const { rm } = await import('node:fs/promises');
		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-run-'));
		try {
			const evalCase = {
				id: 'needs-missing-bin',
				fixture: fixtureDir,
				test: 'node --test',
				requires: ['__nonexistent_tool_xyz__'],
				expectFailingBaseline: false,
				heal: false,
				prompt: 'Fix it.',
				assertions: [],
			};
			const opts = parseArgs(['run', '-p', 'x', '--model', 'fake'], {
				BASE_URL: 'http://localhost:1',
			});
			const options = {
				...opts,
				yes: true,
				dryRun: false,
				_runPrompt: runPrompt,
			};
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);
			assert.equal(result.status, 'skipped');
			assert.ok(result.reason.includes('__nonexistent_tool_xyz__'));
		} finally {
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// --record appends to JSONL; without --record nothing changes
// ---------------------------------------------------------------------------

describe('recordResults', () => {
	it('appends exactly one well-formed line to the expected path', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-record-'));
		const { rm } = await import('node:fs/promises');
		try {
			const caseResults = [
				{ id: 'c1', status: 'ran', ok: true, score: 1, durationMs: 100 },
				{ id: 'c2', status: 'skipped', reason: 'no go', durationMs: 5 },
			];
			const filePath = await recordResults(
				cwd,
				'brownfield',
				'qwen/qwen3.6',
				caseResults,
				new Map(),
			);
			const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
			assert.equal(lines.length, 1);
			const parsed = JSON.parse(lines[0]);
			assert.equal(parsed.suiteName, 'brownfield');
			assert.equal(parsed.model, 'qwen/qwen3.6');
			assert.equal(parsed.passCount, 1);
			assert.equal(parsed.totalCount, 1);
			assert.ok(Array.isArray(parsed.cases));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it('appending twice yields two lines', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-record-'));
		const { rm } = await import('node:fs/promises');
		try {
			const results = [
				{ id: 'c', status: 'ran', ok: true, score: 1, durationMs: 50 },
			];
			const fp = await recordResults(
				cwd,
				'brownfield',
				'model-a',
				results,
				new Map(),
			);
			await recordResults(cwd, 'brownfield', 'model-a', results, new Map());
			const lines = (await readFile(fp, 'utf8')).trim().split('\n');
			assert.equal(lines.length, 2);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// parseArgs — new flags
// ---------------------------------------------------------------------------

describe('parseArgs — eval flags', () => {
	it('parses --record flag', () => {
		const opts = parseArgs(['eval', '--suite', 'evals/x.json', '--record']);
		assert.equal(opts.record, true);
	});

	it('defaults record to false', () => {
		const opts = parseArgs(['eval', '--suite', 'evals/x.json']);
		assert.equal(opts.record, false);
	});

	it('parses --cases flag', () => {
		const opts = parseArgs([
			'eval',
			'--suite',
			'evals/x.json',
			'--cases',
			'a,b,c',
		]);
		assert.deepEqual(opts.evalCases, ['a', 'b', 'c']);
	});

	it('defaults evalCases to empty array', () => {
		const opts = parseArgs(['eval', '--suite', 'evals/x.json']);
		assert.deepEqual(opts.evalCases, []);
	});
});

// ---------------------------------------------------------------------------
// Suite hygiene: npm test discovery must not reach evals/fixtures/
// ---------------------------------------------------------------------------

describe('suite hygiene', () => {
	it('npm test discovery command does not scan evals/fixtures/', async () => {
		const { execFile } = await import('node:child_process');
		const { promisify } = await import('node:util');
		const exec = promisify(execFile);

		// Replicate the find command from package.json scripts.test
		const { stdout } = await exec(
			'find',
			[
				'test',
				'examples',
				'-path',
				'*/node_modules/*',
				'-prune',
				'-o',
				'-path',
				'*/.kodr*/*',
				'-prune',
				'-o',
				'-name',
				'*.test.mjs',
				'-print',
			],
			{ cwd: join(import.meta.dirname, '..') },
		);

		const files = stdout.split('\n').filter(Boolean);
		const evalFiles = files.filter((f) => f.startsWith('evals/'));
		assert.deepEqual(
			evalFiles,
			[],
			`evals/ files leaked into test discovery: ${evalFiles}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Mutation guard: fixture directory is byte-identical after a run
// ---------------------------------------------------------------------------

describe('fixture mutation guard', () => {
	it('committed fixture dir is unchanged after staging and running a case', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fix-'));
		const { rm } = await import('node:fs/promises');
		await mkdir(join(fixtureDir, 'test'), { recursive: true });
		await writeFile(join(fixtureDir, 'src.mjs'), 'export const v = 1;\n');
		await writeFile(
			join(fixtureDir, 'test', 't.test.mjs'),
			"import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('ok', () => { assert.ok(true); });\n",
		);

		// Stage the fixture — should not mutate the original
		const { stagedDir } = await stageFixture(fixtureDir);
		// Write something in staged dir to simulate a run
		await writeFile(join(stagedDir, 'src.mjs'), 'export const v = 99;\n');

		try {
			// The original fixture must still have v = 1
			const content = await readFile(join(fixtureDir, 'src.mjs'), 'utf8');
			assert.equal(
				content,
				'export const v = 1;\n',
				'staged write must not affect original fixture',
			);
			// The two dirs should now differ (guard works in the other direction too)
			assert.equal(await directoriesIdentical(fixtureDir, stagedDir), false);
		} finally {
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(stagedDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Artifacts: per-case run dirs land under eval run dir
// ---------------------------------------------------------------------------

describe('case artifact directories', () => {
	it('case run dir is created under the eval run dir', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fix-'));
		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-run-'));
		const { rm } = await import('node:fs/promises');
		await mkdir(join(fixtureDir, 'test'), { recursive: true });
		await writeFile(
			join(fixtureDir, 'test', 'ok.test.mjs'),
			"import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nit('ok', () => { assert.ok(true); });\n",
		);

		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: fakeResponse, role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});
		try {
			const evalCase = {
				id: 'artifact-test',
				fixture: fixtureDir,
				test: 'node --test',
				requires: [],
				expectFailingBaseline: false,
				heal: false,
				prompt: 'No-op.',
				assertions: [],
			};
			const opts = parseArgs(['run', '-p', 'x', '--model', 'fake'], {
				BASE_URL: server.baseUrl,
			});
			const options = {
				...opts,
				yes: true,
				dryRun: false,
				_runPrompt: runPrompt,
			};
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);
			assert.equal(result.status, 'ran');
			// The caseRunDir must be inside evalRunDir/cases/artifact-test
			const expectedCaseRunDir = join(evalRunDir, 'cases', 'artifact-test');
			const info = await stat(expectedCaseRunDir);
			assert.ok(info.isDirectory(), 'case run dir should be a directory');
		} finally {
			await server.close();
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// runError is recorded and suite continues
// ---------------------------------------------------------------------------

describe('runWorkspaceCase — runError recorded, suite continues', () => {
	it('records runError when runPrompt throws and still scores assertions', async () => {
		const fixtureDir = await mkdtemp(join(tmpdir(), 'kodr-fix-'));
		const evalRunDir = await mkdtemp(join(tmpdir(), 'kodr-run-'));
		const { rm } = await import('node:fs/promises');
		await writeFile(join(fixtureDir, 'readme.txt'), 'hello');
		try {
			const evalCase = {
				id: 'run-error-case',
				fixture: fixtureDir,
				test: 'node --test',
				requires: [],
				expectFailingBaseline: false,
				heal: false,
				prompt: 'Fix it.',
				assertions: [{ type: 'files_absent', paths: ['phantom.mjs'] }],
			};
			const opts = parseArgs(['run', '-p', 'x', '--model', 'fake'], {
				BASE_URL: 'http://127.0.0.1:1',
			});
			// Deliberately bad URL so runPrompt throws
			const options = {
				...opts,
				yes: true,
				dryRun: false,
				_runPrompt: runPrompt,
			};
			const result = await runWorkspaceCase(
				evalCase,
				fixtureDir,
				options,
				{ env: {}, cwd: evalRunDir },
				evalRunDir,
			);
			assert.equal(
				result.status,
				'ran',
				'status should be ran even with a run error',
			);
			assert.ok(result.runError, 'runError should be recorded');
			// Assertions still run — files_absent for phantom.mjs should pass (it was never created)
			const absent = result.assertions.find((a) => a.type === 'files_absent');
			assert.equal(absent.ok, true, 'files_absent should still be evaluated');
		} finally {
			await rm(fixtureDir, { recursive: true, force: true });
			await rm(evalRunDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// main eval command — --record writes to evals/results/
// ---------------------------------------------------------------------------

describe('main eval — --record integration', () => {
	it('appends to evals/results/ when --record is passed', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-main-eval-'));
		const { rm } = await import('node:fs/promises');
		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [{ path: 'src/x.mjs', content: 'export const x = 1;' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: fakeResponse, role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});
		try {
			const suite = {
				name: 'smoke-record',
				cases: [
					{
						id: 'gen',
						prompt: 'Generate src/x.mjs',
						assertions: [{ type: 'files_exist', paths: ['src/x.mjs'] }],
					},
				],
			};
			await writeFile(join(cwd, 'suite.json'), JSON.stringify(suite));

			let output = '';
			const io = {
				cwd,
				env: { BASE_URL: server.baseUrl },
				stdout: { write: (s) => (output += s) },
			};
			await main(
				['eval', '--suite', 'suite.json', '--model', 'test-model', '--record'],
				io,
			);

			const resultsPath = join(
				cwd,
				'evals',
				'results',
				'smoke-record',
				'test-model.jsonl',
			);
			const content = await readFile(resultsPath, 'utf8');
			assert.ok(content.trim().length > 0, 'JSONL file should have content');
			const parsed = JSON.parse(content.trim());
			assert.equal(parsed.suiteName, 'smoke-record');
		} finally {
			await server.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it('does not write to evals/results/ when --record is absent', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-main-eval-norec-'));
		const { rm } = await import('node:fs/promises');
		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [{ path: 'src/x.mjs', content: 'x' }],
			patches: [],
			messages: [],
			scratchpad: '',
		});
		const server = await startFakeModelServer({
			responses: [
				{
					method: 'POST',
					url: '/v1/chat/completions',
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: fakeResponse, role: 'assistant' },
							},
						],
						id: 'chatcmpl_1',
						object: 'chat.completion',
					},
					status: 200,
				},
			],
		});
		try {
			const suite = {
				name: 'smoke-norec',
				cases: [{ id: 'g', prompt: 'Gen', assertions: [] }],
			};
			await writeFile(join(cwd, 'suite.json'), JSON.stringify(suite));
			const io = {
				cwd,
				env: { BASE_URL: server.baseUrl },
				stdout: { write: () => {} },
			};
			await main(
				['eval', '--suite', 'suite.json', '--model', 'test-model'],
				io,
			);

			let exists = false;
			try {
				await stat(join(cwd, 'evals', 'results'));
				exists = true;
			} catch {
				// expected
			}
			assert.equal(
				exists,
				false,
				'evals/results/ must not be created without --record',
			);
		} finally {
			await server.close();
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
