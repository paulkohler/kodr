import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { main } from '../src/app.mjs';
import { stripAnsi } from '../src/ansi.mjs';
import {
	createTuiState,
	expandFileReferences,
	handleTuiLine,
	renderColoredDiff,
	renderFooter,
	runTui,
} from '../src/tui.mjs';

describe('terminal turn ui', () => {
	it('routes normal input through the run-turn channel request', async () => {
		const state = createTuiState({
			model: 'test-model',
			provider: 'local',
			timeoutMs: 1000,
		});
		const calls = [];
		const stdout = captureStream();

		const result = await handleTuiLine(
			state,
			'write a parser',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					applied: false,
					ok: true,
					response: 'Plain response.',
					runDir: '/tmp/run-1',
					sessionId: 'run-1',
					writeResult: { writes: [] },
				};
			},
		);

		assert.equal(result.type, 'turn');
		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, 'run-turn');
		assert.equal(calls[0].options.prompt, 'write a parser');
		assert.equal(calls[0].options.model, 'test-model');
		assert.equal(calls[0].options.sessionId, '');
		assert.equal(state.sessionId, 'run-1');
		assert.match(stdout.text, /Plain response/u);
		assert.match(stdout.text, /request model=test-model/u);
	});

	it('prints progress events from the run channel', async () => {
		const state = createTuiState({
			model: 'test-model',
			provider: 'local',
			timeoutMs: 1000,
		});
		const stdout = captureStream();

		await handleTuiLine(
			state,
			'write a parser',
			{ stdout },
			async (request) => {
				request.options.onProgress({
					agent: 'planner',
					event: 'subagent_start',
					model: 'test-model',
				});
				request.options.onProgress({
					agent: 'planner',
					durationMs: 25,
					event: 'subagent_finish',
					model: 'test-model',
					responseChars: 123,
				});
				return {
					applied: false,
					ok: true,
					response: 'done',
					runDir: '/tmp/run-progress',
					sessionId: 'run-progress',
					writeResult: { writes: [] },
				};
			},
		);

		assert.match(stdout.text, /planner started model=test-model/u);
		assert.match(stdout.text, /planner finished response=123 chars/u);
	});

	it('prints subagent planner and reviewer summaries', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		await handleTuiLine(state, 'build it', { stdout }, async () => {
			return {
				applied: true,
				ok: true,
				orchestration: {
					agents: { planner: { planChars: 321 } },
					review: { pass: true, summary: 'Complete.' },
				},
				proposal: { messages: [] },
				runDir: '/tmp/run-subagents',
				sessionId: 'run-subagents',
				writeResult: { writes: [{ path: 'src/a.mjs', status: 'create' }] },
			};
		});

		assert.match(stdout.text, /planner=321 chars/u);
		assert.match(stdout.text, /review=passed Complete/u);
	});

	it('shows proposalError message instead of raw response JSON', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		await handleTuiLine(state, 'build it', { stdout }, async () => ({
			applied: false,
			ok: false,
			proposal: null,
			proposalError: {
				message: 'Proposal files must have string path and content',
				name: 'ProposalValidationError',
			},
			response:
				'```json\n{"summary":"plan","files":[{"path":"src/a.mjs","responsibility":"does stuff"}]}\n```',
			runDir: '/tmp/run-err',
			sessionId: 'run-err',
			writeResult: { writes: [] },
		}));

		assert.match(stdout.text, /ProposalValidationError/u);
		assert.match(
			stdout.text,
			/Proposal files must have string path and content/u,
		);
		assert.doesNotMatch(stdout.text, /summary.*plan/u);
	});

	it('keeps slash commands out of the model channel', async () => {
		const state = createTuiState({ model: 'test-model' });
		let calls = 0;
		const stdout = captureStream();

		await handleTuiLine(state, '/apply on', { stdout }, async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/tools on', { stdout }, async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/model other-model', { stdout }, async () => {
			calls += 1;
		});

		assert.equal(calls, 0);
		assert.equal(state.apply, true);
		assert.equal(state.tools, true);
		assert.equal(state.model, 'other-model');
	});

	it('selects sessions and sends following turns through that session', async () => {
		const state = createTuiState({ model: 'test-model' });
		const calls = [];

		await handleTuiLine(
			state,
			'/use session-a',
			captureIo(),
			async (request) => {
				calls.push(request);
			},
		);
		await handleTuiLine(state, 'follow up', captureIo(), async (request) => {
			calls.push(request);
			return {
				applied: false,
				ok: true,
				response: 'ok',
				runDir: '/tmp/run-2',
				sessionId: 'session-a',
				writeResult: { writes: [] },
			};
		});

		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, 'run-turn');
		assert.equal(calls[0].options.sessionId, 'session-a');
	});

	it('runs an interactive quit loop from main', async () => {
		const stdout = captureStream();
		const result = await main(['tui'], {
			cwd: process.cwd(),
			env: {},
			stderr: captureStream(),
			stdin: Readable.from(['/quit\n']),
			stdout,
		});

		assert.equal(result.command, 'tui');
		assert.equal(result.ok, true);
		assert.match(stdout.text, /kodr /u);
		assert.match(stdout.text, /assistant> bye/u);
	});

	it('exits cleanly when piped input ends after a turn', async () => {
		const stdout = captureStream();
		const result = await runTui(
			{ model: 'test-model' },
			{
				stderr: captureStream(),
				stdin: Readable.from(['one turn\n']),
				stdout,
			},
			async () => {
				return {
					applied: false,
					ok: true,
					response: 'done',
					runDir: '/tmp/run-eof',
					sessionId: 'run-eof',
					writeResult: { writes: [] },
				};
			},
		);

		assert.equal(result.ok, true);
		assert.equal(result.reason, 'eof');
		assert.match(stdout.text, /done/u);
	});

	it('lists and shows sessions through slash commands', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, '/sessions', { stdout }, async (request) => {
			calls.push(request);
			return [
				{
					model: 'test-model',
					ok: true,
					sessionId: 'session-a',
					turnCount: 2,
				},
			];
		});
		await handleTuiLine(
			state,
			'/show session-a',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					sessionId: 'session-a',
					turns: [{ assistant: 'hello', user: 'hi' }],
				};
			},
		);

		assert.deepEqual(
			calls.map((call) => call.kind),
			['session-list', 'session-show'],
		);
		assert.match(stdout.text, /session-a/u);
		assert.match(stdout.text, /assistant: hello/u);
	});

	it('runs TUI inspection slash commands without model turns', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];
		const inspectResult = {
			files: [
				{
					language: 'javascript',
					path: 'src/app.mjs',
					symbols: [
						{
							kind: 'function',
							lineEnd: 3,
							lineStart: 1,
							name: 'runPrompt',
						},
					],
				},
			],
			languages: { javascript: 1 },
			references: [
				{ line: 1, path: 'src/app.mjs', text: 'function runPrompt() {}' },
			],
			symbols: [
				{
					kind: 'function',
					lineEnd: 3,
					lineStart: 1,
					name: 'runPrompt',
					path: 'src/app.mjs',
				},
			],
		};

		await handleTuiLine(
			state,
			'/inspect runPrompt',
			{ stdout },
			async (request) => {
				calls.push(request);
				return inspectResult;
			},
		);
		await handleTuiLine(
			state,
			'/refs runPrompt',
			{ stdout },
			async (request) => {
				calls.push(request);
				return inspectResult;
			},
		);

		assert.deepEqual(
			calls.map((call) => call.kind),
			['inspect', 'inspect'],
		);
		assert.equal(calls[0].symbol, 'runPrompt');
		assert.equal(calls[1].symbol, 'runPrompt');
		assert.match(stdout.text, /Code inspection: 1 files, 1 symbols/u);
		assert.match(stdout.text, /References for runPrompt: 1/u);
	});

	it('runs TUI file inspection without model turns', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(
			state,
			'/inspect src/app.mjs',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					files: [{ language: 'javascript', path: 'src/app.mjs', symbols: [] }],
					languages: { javascript: 1 },
					references: [],
					symbols: [],
				};
			},
		);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, 'inspect');
		assert.equal(calls[0].filePath, 'src/app.mjs');
		assert.equal(calls[0].symbol, '');
		assert.match(stdout.text, /File: src\/app\.mjs/u);
	});

	it('stores pending reviews for dry-run write proposals', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		await handleTuiLine(state, 'change a file', { stdout }, async () => {
			return proposalResult({ applied: false });
		});

		assert.ok(state.pendingReview);
		assert.equal(state.pendingReview.prompt, 'change a file');
		assert.match(stdout.text, /pending review/u);
		assert.match(stdout.text, /src\/index.mjs/u);
	});

	it('stores and resolves pending permission prompts through slash commands', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, 'install deps', { stdout }, async (request) => {
			calls.push(request);
			return {
				ok: false,
				permissionRequest: {
					action: 'run_command',
					input: { command: 'npm install' },
					reason: 'Command is denied by policy: npm install',
					status: 'pending',
				},
				response: 'permission required',
				runDir: '/tmp/run-permission',
				sessionId: 'permission-session',
				writeResult: { writes: [] },
			};
		});
		await handleTuiLine(state, '/allow', { stdout }, async (request) => {
			calls.push(request);
			return {
				decision: request.decision,
				request: request.request,
				status: 'approved',
			};
		});

		assert.equal(state.pendingPermission, null);
		assert.equal(calls[0].kind, 'run-turn');
		assert.equal(calls[1].kind, 'permission-decision');
		assert.equal(calls[1].decision, 'allow');
		assert.match(stdout.text, /permission required/u);
		assert.match(stdout.text, /permission approved/u);
	});

	it('denies pending permission prompts without running a model turn', async () => {
		const state = createTuiState({ model: 'test-model' });
		state.pendingPermission = {
			action: 'write_file',
			input: { path: 'README.md' },
			reason: 'Applying writes is denied by policy',
			status: 'pending',
		};
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(
			state,
			'/deny not safe',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					decision: request.decision,
					reason: request.reason,
					request: request.request,
					status: 'denied',
				};
			},
		);

		assert.equal(state.pendingPermission, null);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].kind, 'permission-decision');
		assert.equal(calls[0].decision, 'deny');
		assert.equal(calls[0].reason, 'not safe');
		assert.match(stdout.text, /permission denied/u);
	});

	it('accepts a pending review by applying the proposal directly without re-running the model', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, 'change a file', { stdout }, async (request) => {
			calls.push(request);
			return proposalResult({ applied: false });
		});
		await handleTuiLine(state, '/accept', { stdout }, async (request) => {
			calls.push(request);
			return {
				applied: true,
				ok: true,
				proposal: request.proposal,
				runDir: '/tmp/run-applied',
				sessionId: 'applied-session',
				writeResult: {
					writes: [{ path: 'src/index.mjs', status: 'modify' }],
				},
			};
		});

		assert.equal(calls.length, 2);
		assert.equal(calls[1].kind, 'apply-proposal');
		assert.ok(calls[1].proposal, 'proposal should be forwarded');
		assert.equal(state.pendingReview, null);
		assert.match(stdout.text, /applying pending writes/u);
		assert.match(stdout.text, /writes=1 mode=applied/u);
	});

	it('shows NOT-applied error line in pending review display', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		await handleTuiLine(state, 'change a file', { stdout }, async () => {
			return proposalResult({ applied: false });
		});

		assert.match(stdout.text, /NOT applied/u);
		assert.match(stdout.text, /\/accept \(apply\)/u);
	});

	it('/accept warns when pending review has no proposal', async () => {
		const state = createTuiState({ model: 'test-model' });
		state.pendingReview = {
			options: {},
			prompt: 'do something',
			result: {
				proposal: null,
				runDir: '/tmp/r',
				sessionId: 's',
				writeResult: { writes: [] },
			},
		};
		const stdout = captureStream();
		const calls = [];

		const result = await handleTuiLine(
			state,
			'/accept',
			{ stdout },
			async (req) => {
				calls.push(req);
			},
		);

		assert.equal(calls.length, 0);
		assert.equal(result.ok, false);
		assert.match(stdout.text, /nothing to apply/u);
	});

	it('rejects and reprints pending reviews without model calls', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();
		let calls = 0;

		await handleTuiLine(state, 'change a file', { stdout }, async () => {
			calls += 1;
			return proposalResult({ applied: false });
		});
		await handleTuiLine(state, '/review', { stdout }, async () => {
			calls += 1;
		});
		await handleTuiLine(state, '/reject', { stdout }, async () => {
			calls += 1;
		});

		assert.equal(calls, 1);
		assert.equal(state.pendingReview, null);
		assert.match(stdout.text, /review rejected/u);
	});

	it('runs configured pending-review tests through the channel', async () => {
		const state = createTuiState({
			model: 'test-model',
			testCommand: 'npm test',
		});
		const stdout = captureStream();
		const calls = [];

		await handleTuiLine(state, 'change a file', { stdout }, async (request) => {
			calls.push(request);
			return proposalResult({ applied: false });
		});
		await handleTuiLine(state, '/test', { stdout }, async (request) => {
			calls.push(request);
			return { command: 'npm test', ok: true };
		});

		assert.deepEqual(
			calls.map((call) => call.kind),
			['run-turn', 'verify-command'],
		);
		assert.match(stdout.text, /tests=passed/u);
	});

	it('prints elapsed status while a turn is running', async () => {
		const state = createTuiState({
			model: 'test-model',
			tuiStatusIntervalMs: 5,
		});
		const stdout = captureStream();

		await handleTuiLine(state, 'slow turn', { stdout }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 12));
			return {
				applied: false,
				ok: true,
				response: 'done',
				runDir: '/tmp/run-slow',
				sessionId: 'run-slow',
				writeResult: { writes: [] },
			};
		});

		assert.match(stdout.text, /elapsed=0s/u);
	});

	it('prints streamed chunks from the run channel', async () => {
		const state = createTuiState({
			model: 'test-model',
			stream: true,
		});
		const stdout = captureStream();

		await handleTuiLine(state, 'stream turn', { stdout }, async (request) => {
			request.options.onStreamContent('chunk-a');
			request.options.onStreamContent(' chunk-b');
			return {
				applied: false,
				ok: true,
				response: 'chunk-a chunk-b',
				runDir: '/tmp/run-stream',
				sessionId: 'run-stream',
				writeResult: { writes: [] },
			};
		});

		assert.match(stdout.text, /assistant> stream:/u);
		assert.match(stdout.text, /chunk-a chunk-b/u);
		assert.equal(stdout.text.match(/chunk-a chunk-b/gu).length, 1);
		assert.match(stdout.text, /chunk-a chunk-b\nassistant>/u);
	});

	it('colors TUI status output when FORCE_COLOR is set', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		await handleTuiLine(
			state,
			'/status',
			{ env: { FORCE_COLOR: '1' }, stdout },
			async () => {},
		);

		assert.match(stdout.text, /\u001B\[/u);
		assert.match(stripAnsi(stdout.text), /assistant> session=new/u);
	});

	it('does not color TUI output when NO_COLOR is set', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream({ isTTY: true });

		await handleTuiLine(
			state,
			'/status',
			{ env: { NO_COLOR: '1' }, stdout },
			async () => {},
		);

		assert.doesNotMatch(stdout.text, /\u001B\[/u);
		assert.match(stdout.text, /assistant> session=new/u);
	});

	it('keeps non-TUI CLI output plain when color is forced', async () => {
		const stdout = captureStream({ isTTY: true });

		await main(['--version'], {
			cwd: process.cwd(),
			env: { FORCE_COLOR: '1' },
			stderr: captureStream(),
			stdin: Readable.from([]),
			stdout,
		});

		assert.doesNotMatch(stdout.text, /\[/u);
	});

	it('renderColoredDiff colors diff lines by prefix', async () => {
		const writes = [
			{
				diff: '--- a/src/foo.mjs\n+++ b/src/foo.mjs\n@@ -1,3 +1,3 @@\n context line\n-removed line\n+added line',
				path: 'src/foo.mjs',
				status: 'modify',
			},
		];
		const { createTuiView } = await import('../src/tui.mjs');
		const env = { FORCE_COLOR: '1' };
		const stdout = captureStream();
		const view = createTuiView({ env, stdout });
		const output = renderColoredDiff(writes, view);

		assert.match(output, /diff: src\/foo\.mjs/u);
		assert.match(output, /\[1m---/u);
		assert.match(output, /\[1m\+\+\+/u);
		assert.match(output, /\[36m@@/u);
		assert.match(output, /\[32m\+added line/u);
		assert.match(output, /\[31m-removed line/u);
		assert.match(output, /context line/u);
	});

	it('renderColoredDiff returns empty string when no diffs', () => {
		const writes = [{ path: 'src/foo.mjs', status: 'create' }];
		const output = renderColoredDiff(writes);
		assert.equal(output, '');
	});

	it('expandFileReferences inlines existing files and skips missing ones', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'tui-test-'));
		try {
			await writeFile(join(dir, 'hello.js'), 'console.log("hi");');
			const { expandedPrompt, files } = await expandFileReferences(
				'fix @hello.js and @missing.txt please',
				dir,
			);
			assert.equal(files.length, 1);
			assert.equal(files[0].path, 'hello.js');
			assert.equal(files[0].chars, 'console.log("hi");'.length);
			assert.match(expandedPrompt, /## @hello\.js/u);
			assert.match(expandedPrompt, /console\.log\("hi"\)/u);
			assert.match(expandedPrompt, /fix @hello\.js and @missing\.txt please/u);
			assert.doesNotMatch(expandedPrompt, /## @missing\.txt/u);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it('expandFileReferences returns original prompt when no @refs present', async () => {
		const { expandedPrompt, files } = await expandFileReferences(
			'no references here',
			'/tmp',
		);
		assert.equal(expandedPrompt, 'no references here');
		assert.deepEqual(files, []);
	});

	it('expandFileReferences deduplicates repeated @refs', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'tui-test-'));
		try {
			await writeFile(join(dir, 'a.js'), 'const x = 1;');
			const { files } = await expandFileReferences(
				'check @a.js and @a.js again',
				dir,
			);
			assert.equal(files.length, 1);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it('renderFooter shows model, session, and review indicator', () => {
		const state = createTuiState({ model: 'qwen-35b', sessionId: 'sess-abc' });
		state.pendingReview = { options: {}, prompt: 'x', result: {} };
		const output = renderFooter(state, null);
		assert.match(output, /model=qwen-35b/u);
		assert.match(output, /session=sess-abc/u);
		assert.match(output, /\[review pending\]/u);
	});

	it('renderFooter shows token counts when result has usage', () => {
		const state = createTuiState({ model: 'test-model', sessionId: 'sess-1' });
		const result = {
			usage: { completionTokens: 42, promptTokens: 100, tokens: 142 },
		};
		const output = renderFooter(state, result);
		assert.match(output, /prompt=100/u);
		assert.match(output, /completion=42/u);
		assert.match(output, /total=142/u);
	});

	it('renderFooter omits token section when result has no usage', () => {
		const state = createTuiState({ model: 'test-model', sessionId: 'sess-1' });
		const output = renderFooter(state, { ok: true });
		assert.doesNotMatch(output, /tokens/u);
		assert.match(output, /model=test-model/u);
	});

	it('/retry re-runs the last prompt', async () => {
		const state = createTuiState({ model: 'test-model' });
		const calls = [];
		const stdout = captureStream();

		await handleTuiLine(state, 'write a parser', { stdout }, async (request) => {
			calls.push(request);
			return {
				applied: false,
				ok: true,
				response: 'done',
				runDir: '/tmp/r1',
				sessionId: 's1',
				writeResult: { writes: [] },
			};
		});

		await handleTuiLine(state, '/retry', { stdout }, async (request) => {
			calls.push(request);
			return {
				applied: false,
				ok: true,
				response: 'done again',
				runDir: '/tmp/r2',
				sessionId: 's2',
				writeResult: { writes: [] },
			};
		});

		assert.equal(calls.length, 2);
		assert.equal(calls[0].options.prompt, 'write a parser');
		assert.equal(calls[1].options.prompt, 'write a parser');
		assert.match(stdout.text, /retrying: write a parser/u);
	});

	it('/retry warns when there is no previous prompt', async () => {
		const state = createTuiState({ model: 'test-model' });
		const stdout = captureStream();

		const result = await handleTuiLine(state, '/retry', { stdout }, async () => {});

		assert.equal(result.ok, false);
		assert.match(stdout.text, /no previous prompt/u);
	});

	it('/retry --model uses a different model temporarily', async () => {
		const state = createTuiState({ model: 'model-a' });
		state.lastPrompt = 'do it';
		const calls = [];
		const stdout = captureStream();

		await handleTuiLine(
			state,
			'/retry --model model-b',
			{ stdout },
			async (request) => {
				calls.push(request);
				return {
					applied: false,
					ok: true,
					response: 'ok',
					runDir: '/tmp/r',
					sessionId: 's',
					writeResult: { writes: [] },
				};
			},
		);

		assert.equal(calls.length, 1);
		assert.equal(calls[0].options.model, 'model-b');
		assert.equal(state.model, 'model-a');
	});

	it('shows attached file note when @refs are expanded', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'tui-test-'));
		try {
			await writeFile(join(dir, 'helper.js'), 'function help() {}');
			const state = createTuiState({ model: 'test-model' });
			const stdout = captureStream();

			await handleTuiLine(
				state,
				'review @helper.js',
				{ cwd: dir, stdout },
				async () => ({
					applied: false,
					ok: true,
					response: 'reviewed',
					runDir: '/tmp/r',
					sessionId: 's',
					writeResult: { writes: [] },
				}),
			);

			assert.match(stdout.text, /attached: helper\.js/u);
		} finally {
			await rm(dir, { recursive: true });
		}
	});
});


function proposalResult(options = {}) {
	return {
		applied: options.applied ?? false,
		ok: true,
		proposal: {
			messages: [{ content: 'Ready to apply.', level: 'info' }],
		},
		runDir: options.runDir || '/tmp/run-dry',
		sessionId: options.sessionId || 'dry-session',
		writeResult: {
			writes: [{ path: 'src/index.mjs', status: 'modify' }],
		},
	};
}

function captureIo() {
	return { stdout: captureStream() };
}

function captureStream(options = {}) {
	return {
		isTTY: options.isTTY === true,
		text: '',
		write(chunk) {
			this.text += chunk;
		},
	};
}
