import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	EvalError,
	loadEvalSuite,
	runAssertion,
	scoreCase,
} from '../src/eval.mjs';
import { CliError, main, parseArgs } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

// Minimal passing proposal used across several tests
const PASSING_PROPOSAL = {
	files: [
		{ path: 'src/cli.mjs', content: 'export function add() {}' },
		{
			path: 'test/cli.test.mjs',
			content: `import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
describe('cli', () => { it('works', () => { assert.ok(true); }); });
`,
		},
	],
	patches: [],
	messages: [],
};

describe('loadEvalSuite', () => {
	it('parses a valid suite', () => {
		const suite = loadEvalSuite(
			JSON.stringify({
				name: 'my suite',
				description: 'optional',
				cases: [
					{
						id: 'case-1',
						prompt: 'Do something.',
						assertions: [{ type: 'files_exist', paths: ['src/index.mjs'] }],
					},
				],
			}),
		);

		assert.equal(suite.name, 'my suite');
		assert.equal(suite.cases.length, 1);
		assert.equal(suite.cases[0].id, 'case-1');
		assert.equal(suite.cases[0].assertions[0].type, 'files_exist');
	});

	it('throws EvalError on invalid JSON', () => {
		assert.throws(() => loadEvalSuite('not json'), EvalError);
	});

	// Phase 124: the shipped suites must stay valid as they are durable fixtures.
	it('loads the shipped code-quality suite with both trap cases', async () => {
		const { readFile } = await import('node:fs/promises');
		const text = await readFile(
			new URL('../evals/code-quality.json', import.meta.url),
			'utf8',
		);
		const suite = loadEvalSuite(text);
		assert.equal(suite.name, 'code-quality');
		const ids = suite.cases.map((c) => c.id).sort();
		assert.deepEqual(ids, ['cq-esm-cli', 'cq-nodetest']);
		// Every trap case pairs a files_exist with content_absent so a no-write
		// cannot pass vacuously (content_absent is true for a missing file).
		for (const c of suite.cases) {
			const types = c.assertions.map((a) => a.type);
			assert.ok(types.includes('files_exist'), `${c.id} needs files_exist`);
			assert.ok(
				types.includes('content_absent'),
				`${c.id} needs content_absent`,
			);
		}
	});

	it('throws EvalError when name is missing', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						cases: [{ id: 'x', prompt: 'hi', assertions: [] }],
					}),
				),
			EvalError,
		);
	});

	it('throws EvalError when cases is empty', () => {
		assert.throws(
			() => loadEvalSuite(JSON.stringify({ name: 'x', cases: [] })),
			EvalError,
		);
	});

	it('throws EvalError on unknown assertion type', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						name: 'x',
						cases: [
							{
								id: 'c',
								prompt: 'p',
								assertions: [{ type: 'magic_check' }],
							},
						],
					}),
				),
			EvalError,
		);
	});

	it('throws EvalError when files_exist is missing paths', () => {
		assert.throws(
			() =>
				loadEvalSuite(
					JSON.stringify({
						name: 'x',
						cases: [
							{
								id: 'c',
								prompt: 'p',
								assertions: [{ type: 'files_exist', paths: [] }],
							},
						],
					}),
				),
			EvalError,
		);
	});
});

describe('runAssertion — files_exist', () => {
	it('passes when all paths are in the proposal', async () => {
		const result = await runAssertion(
			{ type: 'files_exist', paths: ['src/cli.mjs'] },
			PASSING_PROPOSAL,
		);
		assert.equal(result.ok, true);
	});

	it('fails when a path is missing from the proposal', async () => {
		const result = await runAssertion(
			{ type: 'files_exist', paths: ['src/cli.mjs', 'src/missing.mjs'] },
			PASSING_PROPOSAL,
		);
		assert.equal(result.ok, false);
		assert.ok(result.detail.includes('src/missing.mjs'));
	});

	it('fails gracefully when proposal is null', async () => {
		const result = await runAssertion(
			{ type: 'files_exist', paths: ['src/cli.mjs'] },
			null,
		);
		assert.equal(result.ok, false);
	});

	it('includes patch paths in the check', async () => {
		const proposal = {
			files: [],
			patches: [{ path: 'src/existing.mjs', search: 'x', replace: 'y' }],
		};
		const result = await runAssertion(
			{ type: 'files_exist', paths: ['src/existing.mjs'] },
			proposal,
		);
		assert.equal(result.ok, true);
	});
});

describe('runAssertion — content_matches', () => {
	it('passes when the file content matches the pattern', async () => {
		const result = await runAssertion(
			{ type: 'content_matches', path: 'src/cli.mjs', pattern: 'add' },
			PASSING_PROPOSAL,
		);
		assert.equal(result.ok, true);
	});

	it('fails when the file content does not match', async () => {
		const result = await runAssertion(
			{ type: 'content_matches', path: 'src/cli.mjs', pattern: 'delete' },
			PASSING_PROPOSAL,
		);
		assert.equal(result.ok, false);
	});

	it('fails when the file is not in the proposal', async () => {
		const result = await runAssertion(
			{
				type: 'content_matches',
				path: 'src/nonexistent.mjs',
				pattern: 'foo',
			},
			PASSING_PROPOSAL,
		);
		assert.equal(result.ok, false);
		assert.ok(result.detail.includes('not in proposal'));
	});

	it('fails gracefully on invalid regex', async () => {
		const result = await runAssertion(
			{ type: 'content_matches', path: 'src/cli.mjs', pattern: '[invalid' },
			PASSING_PROPOSAL,
		);
		assert.equal(result.ok, false);
		assert.ok(result.detail.includes('invalid regex'));
	});
});

describe('runAssertion — tests_pass', () => {
	it('passes when the generated tests succeed', async () => {
		const result = await runAssertion(
			{ type: 'tests_pass', command: 'node --test' },
			PASSING_PROPOSAL,
			10000,
		);
		assert.equal(result.ok, true);
	});

	it('fails when the generated tests contain a bug', async () => {
		const brokenProposal = {
			files: [
				{
					path: 'test/broken.test.mjs',
					content: `import assert from 'node:assert/strict';
import { it } from 'node:test';
it('fails', () => { assert.equal(1, 2); });
`,
				},
			],
			patches: [],
		};
		const result = await runAssertion(
			{ type: 'tests_pass', command: 'node --test' },
			brokenProposal,
			10000,
		);
		assert.equal(result.ok, false);
	});

	it('fails when proposal has no files', async () => {
		const result = await runAssertion(
			{ type: 'tests_pass', command: 'node --test' },
			{ files: [], patches: [] },
		);
		assert.equal(result.ok, false);
		assert.ok(result.detail.includes('no files'));
	});
});

describe('scoreCase', () => {
	it('scores 1.0 when all assertions pass', async () => {
		const evalCase = {
			id: 'all-pass',
			assertions: [
				{ type: 'files_exist', paths: ['src/cli.mjs'] },
				{
					type: 'content_matches',
					path: 'src/cli.mjs',
					pattern: 'function',
				},
			],
		};
		const result = await scoreCase(evalCase, PASSING_PROPOSAL, 10000);
		assert.equal(result.ok, true);
		assert.equal(result.score, 1);
		assert.equal(result.passCount, 2);
		assert.equal(result.totalCount, 2);
	});

	it('scores partial when some assertions fail', async () => {
		const evalCase = {
			id: 'partial',
			assertions: [
				{ type: 'files_exist', paths: ['src/cli.mjs'] },
				{ type: 'files_exist', paths: ['missing.mjs'] },
			],
		};
		const result = await scoreCase(evalCase, PASSING_PROPOSAL, 10000);
		assert.equal(result.ok, false);
		assert.equal(result.score, 0.5);
		assert.equal(result.passCount, 1);
	});

	it('scores 1.0 on empty assertion list', async () => {
		const evalCase = { id: 'empty', assertions: [] };
		const result = await scoreCase(evalCase, null, 10000);
		assert.equal(result.score, 1);
		assert.equal(result.ok, true);
	});
});

describe('parseArgs eval command', () => {
	it('parses --suite flag', () => {
		const options = parseArgs(['eval', '--suite', 'evals/my-suite.json']);
		assert.equal(options.command, 'eval');
		assert.equal(options.suitePath, 'evals/my-suite.json');
	});

	it('throws CliError when --suite value is missing', () => {
		assert.throws(() => parseArgs(['eval', '--suite']), CliError);
	});
});

describe('main eval command', () => {
	it('runs eval suite and returns scored results', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-eval-main-'));
		// The model returns a valid JSON proposal with src/index.mjs
		const fakeResponse = JSON.stringify({
			status: 'OK',
			files: [{ path: 'src/index.mjs', content: 'export const x = 1;' }],
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
			let output = '';
			const io = {
				cwd,
				env: { BASE_URL: server.baseUrl },
				stdout: { write: (s) => (output += s) },
			};

			// Write a suite file into the temp cwd
			const { writeFile } = await import('node:fs/promises');
			const suite = {
				name: 'smoke',
				cases: [
					{
						id: 'generates-index',
						prompt: 'Generate src/index.mjs',
						assertions: [{ type: 'files_exist', paths: ['src/index.mjs'] }],
					},
				],
			};
			await writeFile(join(cwd, 'suite.json'), JSON.stringify(suite), 'utf8');

			const result = await main(
				['eval', '--suite', 'suite.json', '--model', 'test-model'],
				io,
			);

			assert.equal(result.ok, true);
			assert.equal(result.command, 'eval');
			assert.ok(output.includes('Eval: smoke'));
			assert.ok(output.includes('pass'));
		} finally {
			await server.close();
		}
	});

	it('throws CliError when --suite is absent', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-eval-noarg-'));
		const io = { cwd, env: {}, stdout: { write: () => {} } };
		await assert.rejects(() => main(['eval'], io), CliError);
	});
});
