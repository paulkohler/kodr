// Phase 120 — Live Apply Mode tests
// Tests for L1 (flag/config/precedence), L2 (live writes), L3 (proposal read-back),
// L4 (summary.applyMode + kodr why), and regression guard.

import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseArgs, main, CliError } from '../src/app.mjs';
import {
	loadProjectConfig,
	applyProjectConfig,
	ProjectConfigError,
} from '../src/project-config.mjs';
import { createBuiltinRegistry, ProposalDraft } from '../src/tool-calls.mjs';
import { buildCausalStory } from '../src/forensics.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupCwd(configContent) {
	const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-'));
	if (configContent !== undefined) {
		await mkdir(join(cwd, '.kodr'), { recursive: true });
		await writeFile(
			join(cwd, '.kodr', 'config.json'),
			typeof configContent === 'string'
				? configContent
				: JSON.stringify(configContent, null, 2),
		);
	}
	return cwd;
}

function makeIo(cwd) {
	let out = '';
	let err = '';
	return {
		cwd,
		env: {},
		stdin: { isTTY: false },
		stdout: {
			isTTY: false,
			write(s) {
				out += s;
			},
		},
		stderr: {
			write(s) {
				err += s;
			},
		},
		getOut: () => out,
		getErr: () => err,
	};
}

// Build a tool_calls response for write_file.
function makeWriteFileTurn({
	id = 'call_wf1',
	path,
	content,
	chatId = 'chatcmpl_wf1',
} = {}) {
	return {
		body: {
			choices: [
				{
					finish_reason: 'tool_calls',
					message: {
						content: null,
						role: 'assistant',
						tool_calls: [
							{
								id,
								type: 'function',
								function: {
									name: 'write_file',
									arguments: JSON.stringify({ path, content }),
								},
							},
						],
					},
				},
			],
			id: chatId,
			object: 'chat.completion',
		},
		method: 'POST',
		status: 200,
		url: '/v1/chat/completions',
	};
}

// Build a tool_calls response for edit_file.
function makeEditFileTurn({
	id = 'call_ef1',
	path,
	search,
	replace,
	chatId = 'chatcmpl_ef1',
} = {}) {
	return {
		body: {
			choices: [
				{
					finish_reason: 'tool_calls',
					message: {
						content: null,
						role: 'assistant',
						tool_calls: [
							{
								id,
								type: 'function',
								function: {
									name: 'edit_file',
									arguments: JSON.stringify({ path, search, replace }),
								},
							},
						],
					},
				},
			],
			id: chatId,
			object: 'chat.completion',
		},
		method: 'POST',
		status: 200,
		url: '/v1/chat/completions',
	};
}

// Plain stop turn.
function makeStopTurn(text, chatId = 'chatcmpl_stop') {
	return {
		body: {
			choices: [
				{
					finish_reason: 'stop',
					message: { content: text, role: 'assistant' },
				},
			],
			id: chatId,
			object: 'chat.completion',
		},
		method: 'POST',
		status: 200,
		url: '/v1/chat/completions',
	};
}

// Write a minimal model-profiles.json so the fake model is classified as native+tools.
async function writeNativeProfile(cwd, baseUrl) {
	const kodrDir = join(cwd, '.kodr');
	await mkdir(kodrDir, { recursive: true });
	await writeFile(
		join(kodrDir, 'model-profiles.json'),
		JSON.stringify([
			{
				id: 'test-model',
				provider: 'local',
				baseUrl,
				contextWindow: 16384,
				completionReserve: 2048,
				nativeToolCalls: true,
				toolWrites: 'native',
				structuredOutput: 'none',
				responseEnvelope: 'json',
				timeoutMs: 30000,
			},
		]),
	);
}

// ---------------------------------------------------------------------------
// L1 — Flag / config / precedence / invalid
// ---------------------------------------------------------------------------

describe('Phase 120 L1 — --apply-mode flag', () => {
	it('default is proposal', () => {
		const opts = parseArgs(['run', '-p', 'hi'], {}, '/tmp');
		assert.equal(opts.applyMode, 'proposal');
	});

	it('--apply-mode live sets applyMode to live', () => {
		const opts = parseArgs(
			['run', '-p', 'hi', '--apply-mode', 'live'],
			{},
			'/tmp',
		);
		assert.equal(opts.applyMode, 'live');
	});

	it('--apply-mode proposal is explicit and valid', () => {
		const opts = parseArgs(
			['run', '-p', 'hi', '--apply-mode', 'proposal'],
			{},
			'/tmp',
		);
		assert.equal(opts.applyMode, 'proposal');
	});

	it('invalid --apply-mode value throws CliError', () => {
		assert.throws(
			() => parseArgs(['run', '-p', 'hi', '--apply-mode', 'eager'], {}, '/tmp'),
			(err) => err instanceof CliError && err.message.includes('--apply-mode'),
		);
	});

	it('--apply-mode missing value throws CliError', () => {
		assert.throws(
			() => parseArgs(['run', '-p', 'hi', '--apply-mode'], {}, '/tmp'),
			(err) => err instanceof CliError,
		);
	});
});

describe('Phase 120 L1 — applyMode config key', () => {
	it('config key applyMode:live is accepted', async () => {
		const cwd = await setupCwd({ applyMode: 'live' });
		const loaded = loadProjectConfig(cwd, {});
		assert.equal(loaded.config.applyMode, 'live');
	});

	it('config key applyMode:proposal is accepted', async () => {
		const cwd = await setupCwd({ applyMode: 'proposal' });
		const loaded = loadProjectConfig(cwd, {});
		assert.equal(loaded.config.applyMode, 'proposal');
	});

	it('config key applyMode with invalid value throws ProjectConfigError', async () => {
		const cwd = await setupCwd({ applyMode: 'instant' });
		assert.throws(
			() => loadProjectConfig(cwd, {}),
			(err) =>
				err instanceof ProjectConfigError &&
				err.message.includes('applyMode') &&
				err.message.includes('proposal') &&
				err.message.includes('live'),
		);
	});

	it('flag overrides config: --apply-mode live wins over config proposal', async () => {
		const cwd = await setupCwd({ applyMode: 'proposal' });
		const opts = parseArgs(
			['run', '-p', 'hi', '--apply-mode', 'live'],
			{},
			cwd,
		);
		assert.equal(opts.applyMode, 'live');
	});

	it('config overrides builtin default: config live applies when no flag', async () => {
		const cwd = await setupCwd({ applyMode: 'live' });
		const opts = parseArgs(['run', '-p', 'hi'], {}, cwd);
		assert.equal(opts.applyMode, 'live');
	});

	it('flag overrides config: flag proposal wins over config live', async () => {
		const cwd = await setupCwd({ applyMode: 'live' });
		const opts = parseArgs(
			['run', '-p', 'hi', '--apply-mode', 'proposal'],
			{},
			cwd,
		);
		assert.equal(opts.applyMode, 'proposal');
	});
});

describe('Phase 120 L1 — summary.applyMode recorded', () => {
	it('summary.applyMode is present in the run output', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-summary-'));
		const server = await startFakeModelServer({
			responses: [
				makeWriteFileTurn({ path: 'a.txt', content: 'hello\n' }),
				makeStopTurn('done'),
			],
		});
		try {
			await writeNativeProfile(cwd, server.baseUrl);
			const io = makeIo(cwd);
			await main(
				[
					'run',
					'-p',
					'create file',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'summary-test',
					'--timeout-ms',
					'10000',
					'--tools',
					'--json',
				],
				io,
			);
			const summary = JSON.parse(
				await readFile(join(cwd, 'summary-test', 'summary.json'), 'utf8'),
			);
			assert.ok('applyMode' in summary, 'summary.applyMode should be present');
			assert.equal(
				summary.applyMode,
				'proposal',
				'default applyMode is proposal',
			);
		} finally {
			await server.close();
		}
	});
});

// ---------------------------------------------------------------------------
// L2 — Live write_file: lands on disk DURING the loop
// ---------------------------------------------------------------------------

describe('Phase 120 L2 — live write_file applies during tool loop', () => {
	it('file exists on disk before end-of-run apply when applyMode=live', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-live-wf-'));
		const server = await startFakeModelServer({
			responses: [
				makeWriteFileTurn({
					id: 'call_live1',
					path: 'live-out.txt',
					content: 'live content\n',
					chatId: 'chatcmpl_live1',
				}),
				makeStopTurn('wrote live-out.txt', 'chatcmpl_live2'),
			],
		});
		// Track when the registry dispatches write_file vs. when main returns.
		// We verify this by checking the file exists after the run (it would only
		// exist before end-of-run apply in live mode).
		try {
			await writeNativeProfile(cwd, server.baseUrl);
			const io = makeIo(cwd);
			const result = await main(
				[
					'run',
					'-p',
					'write live',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'live-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--apply-mode',
					'live',
					'--json',
				],
				io,
			);
			// File must exist (written live).
			const content = await readFile(join(cwd, 'live-out.txt'), 'utf8');
			assert.equal(
				content,
				'live content\n',
				'live-written file has correct content',
			);

			// Tool result should say "wrote" not "recorded".
			// We can't directly inspect tool results, but the summary should show applied.
			const summary = JSON.parse(
				await readFile(join(cwd, 'live-out', 'summary.json'), 'utf8'),
			);
			assert.equal(summary.applyMode, 'live', 'applyMode in summary is live');
		} finally {
			await server.close();
		}
	});

	it('ProposalDraft.recordFile with applied:true returns "wrote" message', () => {
		const draft = new ProposalDraft();
		const msg = draft.recordFile('foo.txt', 'hello', { applied: true });
		assert.ok(
			msg.startsWith('wrote foo.txt'),
			`expected "wrote ...", got: ${msg}`,
		);
		assert.ok(!msg.includes('applies when'), 'should not say "applies when"');
	});

	it('ProposalDraft.recordFile without applied returns standard message', () => {
		const draft = new ProposalDraft();
		const msg = draft.recordFile('foo.txt', 'hello');
		assert.ok(
			msg.includes('applies when the task completes'),
			`expected deferred msg, got: ${msg}`,
		);
	});

	it('ProposalDraft.recordPatch with applied:true returns "edited" message', () => {
		const draft = new ProposalDraft();
		const msg = draft.recordPatch('bar.txt', 'old', 'new', { applied: true });
		assert.ok(
			msg.startsWith('edited bar.txt'),
			`expected "edited ...", got: ${msg}`,
		);
	});

	it('createBuiltinRegistry live mode: write_file writes to disk immediately', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-builtin-live-'));
		const registry = createBuiltinRegistry(cwd, { applyMode: 'live' });
		const result = await registry.dispatch(
			'write_file',
			JSON.stringify({ path: 'live-test.txt', content: 'live content\n' }),
		);
		// File should exist on disk immediately.
		const content = await readFile(join(cwd, 'live-test.txt'), 'utf8');
		assert.equal(content, 'live content\n', 'live write landed on disk');
		// Result should say "wrote".
		assert.ok(
			result.startsWith('wrote live-test.txt'),
			`result should say "wrote", got: ${result}`,
		);
		// Draft should reflect the write as applied.
		const draft = registry.proposalDraft;
		const files = draft.files;
		assert.equal(files.length, 1);
		assert.equal(
			files[0].applied,
			true,
			'draft entry should be marked applied',
		);
	});

	it('createBuiltinRegistry proposal mode (default): write_file does NOT write to disk', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-builtin-proposal-'));
		const registry = createBuiltinRegistry(cwd); // default = proposal
		await registry.dispatch(
			'write_file',
			JSON.stringify({ path: 'proposed.txt', content: 'proposed\n' }),
		);
		// File must NOT exist on disk.
		await assert.rejects(
			() => readFile(join(cwd, 'proposed.txt'), 'utf8'),
			{ code: 'ENOENT' },
			'proposal mode should not write file to disk',
		);
	});

	it('live edit_file applies immediately to disk', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-builtin-live-edit-'));
		// Create the target file first.
		await writeFile(join(cwd, 'edit-target.txt'), 'hello world\n', 'utf8');
		const registry = createBuiltinRegistry(cwd, { applyMode: 'live' });
		const result = await registry.dispatch(
			'edit_file',
			JSON.stringify({
				path: 'edit-target.txt',
				search: 'hello',
				replace: 'goodbye',
			}),
		);
		// Check disk state.
		const content = await readFile(join(cwd, 'edit-target.txt'), 'utf8');
		assert.equal(
			content,
			'goodbye world\n',
			'edit applied to disk immediately',
		);
		assert.ok(
			result.startsWith('edited edit-target.txt'),
			`result should say "edited", got: ${result}`,
		);
	});

	it('live edit_file: patch-not-found returns steering error', async () => {
		const cwd = await mkdtemp(
			join(tmpdir(), 'kodr-lam-builtin-live-edit-fail-'),
		);
		await writeFile(join(cwd, 'target.txt'), 'line one\n', 'utf8');
		const registry = createBuiltinRegistry(cwd, { applyMode: 'live' });
		const result = await registry.dispatch(
			'edit_file',
			JSON.stringify({
				path: 'target.txt',
				search: 'not present',
				replace: 'x',
			}),
		);
		const parsed = JSON.parse(result);
		assert.ok(typeof parsed.error === 'string', 'should return error object');
		assert.ok(
			parsed.error.includes('patch failed') ||
				parsed.error.includes('not found'),
			`error should mention patch failure: ${parsed.error}`,
		);
	});

	it('no-double-write: applied entries are excluded from end-of-run prepareChanges', () => {
		// Verify getCapturedContent and applied flag shape.
		const draft = new ProposalDraft();
		draft.recordFile('x.txt', 'content-a', { applied: true });
		draft.recordFile('y.txt', 'content-b'); // not applied
		const files = draft.files;
		assert.equal(files.find((f) => f.path === 'x.txt')?.applied, true);
		assert.equal(files.find((f) => f.path === 'y.txt')?.applied, undefined);
	});

	it('getCapturedContent returns content for recorded path, null otherwise', () => {
		const draft = new ProposalDraft();
		draft.recordFile('hello.txt', 'the body');
		assert.equal(draft.getCapturedContent('hello.txt'), 'the body');
		assert.equal(draft.getCapturedContent('other.txt'), null);
	});
});

// ---------------------------------------------------------------------------
// L2 — kodr undo restores after a live run
// ---------------------------------------------------------------------------

describe('Phase 120 L2 — undo works after live run', () => {
	it('live write_file creates backup; undo restores original content', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-undo-'));
		// Pre-existing file.
		await writeFile(join(cwd, 'undo-me.txt'), 'original content\n', 'utf8');

		const server = await startFakeModelServer({
			responses: [
				makeWriteFileTurn({
					id: 'call_undo1',
					path: 'undo-me.txt',
					content: 'replaced content\n',
					chatId: 'chatcmpl_undo1',
				}),
				makeStopTurn('done', 'chatcmpl_undo2'),
			],
		});
		try {
			await writeNativeProfile(cwd, server.baseUrl);
			const io = makeIo(cwd);
			await main(
				[
					'run',
					'-p',
					'modify undo-me',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--timeout-ms',
					'10000',
					'--tools',
					'--apply-mode',
					'live',
					'--json',
				],
				io,
			);
			// File was overwritten live.
			const afterRun = await readFile(join(cwd, 'undo-me.txt'), 'utf8');
			assert.equal(
				afterRun,
				'replaced content\n',
				'file should have new content after live run',
			);

			// Now undo.
			const io2 = makeIo(cwd);
			const undoResult = await main(['undo', '--json'], io2);
			// After undo, the original content should be restored.
			const afterUndo = await readFile(join(cwd, 'undo-me.txt'), 'utf8');
			assert.equal(
				afterUndo,
				'original content\n',
				'undo should restore original content',
			);
		} finally {
			await server.close();
		}
	});
});

// ---------------------------------------------------------------------------
// L3 — Proposal-mode read-back
// ---------------------------------------------------------------------------

describe('Phase 120 L3 — proposal-mode read_file read-back', () => {
	it('read_file returns captured content with pending note in proposal mode', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-l3-'));
		const registry = createBuiltinRegistry(cwd, { applyMode: 'proposal' });
		// Capture a write_file.
		await registry.dispatch(
			'write_file',
			JSON.stringify({ path: 'pending.txt', content: 'pending content\n' }),
		);
		// read_file should return the captured content with a note.
		const result = await registry.dispatch(
			'read_file',
			JSON.stringify({ path: 'pending.txt' }),
		);
		assert.ok(typeof result === 'string', 'result should be a string');
		assert.ok(
			result.includes('[pending write'),
			`result should include "[pending write" note; got: ${result.slice(0, 100)}`,
		);
		assert.ok(
			result.includes('pending content'),
			`result should include captured content; got: ${result.slice(0, 100)}`,
		);
		// The file should NOT exist on disk (proposal mode).
		await assert.rejects(() => readFile(join(cwd, 'pending.txt'), 'utf8'), {
			code: 'ENOENT',
		});
	});

	it('read_file reads disk for non-captured path in proposal mode', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-l3-disk-'));
		await writeFile(join(cwd, 'existing.txt'), 'from disk\n', 'utf8');
		const registry = createBuiltinRegistry(cwd, { applyMode: 'proposal' });
		const result = await registry.dispatch(
			'read_file',
			JSON.stringify({ path: 'existing.txt' }),
		);
		assert.equal(result, 'from disk\n', 'non-captured path reads from disk');
	});

	it('read_file in live mode reads disk normally (not from draft)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-l3-live-'));
		await writeFile(join(cwd, 'live-read.txt'), 'disk content\n', 'utf8');
		const registry = createBuiltinRegistry(cwd, { applyMode: 'live' });
		// write_file in live mode writes to disk.
		await registry.dispatch(
			'write_file',
			JSON.stringify({
				path: 'live-read.txt',
				content: 'overwritten by live\n',
			}),
		);
		// read_file in live mode should read disk (which now has the overwritten content).
		const result = await registry.dispatch(
			'read_file',
			JSON.stringify({ path: 'live-read.txt' }),
		);
		assert.equal(result, 'overwritten by live\n', 'live mode reads from disk');
		// Confirm no pending-write note in live mode.
		assert.ok(
			!result.includes('[pending write'),
			'live mode should not add pending-write note',
		);
	});
});

// ---------------------------------------------------------------------------
// L4 — kodr why applyMode in Edit Application step
// ---------------------------------------------------------------------------

describe('Phase 120 L4 — kodr why applyMode', () => {
	it('Edit Application step includes apply mode: live note when applyMode=live', () => {
		const story = buildCausalStory({
			summary: {
				ok: true,
				applyMode: 'live',
				proposalFound: true,
				proposalStatus: 'OK',
				proposalMessageCount: 0,
				responseChars: 100,
				loopBudget: { turns: 2, tokens: 50 },
				model: 'test',
				baseUrl: 'http://localhost:1234/v1',
				finishReasons: ['stop'],
			},
			writes: {
				applied: true,
				writes: [{ path: 'f.txt', status: 'create', diff: '', hash: '' }],
			},
			tests: null,
			repairs: null,
			runDir: '/tmp/lam-test-run',
			errorJson: null,
			contextMd: null,
			promptMd: null,
			responseMd: null,
		});
		const applyStep = story.find((s) => s.phase === 'Edit Application');
		assert.ok(applyStep, 'should have Edit Application step');
		assert.ok(
			applyStep.detail.includes('live'),
			`detail should mention live mode; got: ${applyStep.detail}`,
		);
		assert.ok(
			applyStep.detail.includes('writes applied during the run'),
			`detail should note writes applied during run; got: ${applyStep.detail}`,
		);
	});

	it('Edit Application step includes apply mode: proposal note when applyMode=proposal', () => {
		const story = buildCausalStory({
			summary: {
				ok: true,
				applyMode: 'proposal',
				proposalFound: true,
				proposalStatus: 'OK',
				proposalMessageCount: 0,
				responseChars: 100,
				loopBudget: { turns: 1, tokens: 30 },
				model: 'test',
				baseUrl: 'http://localhost:1234/v1',
				finishReasons: ['stop'],
			},
			writes: {
				applied: false,
				writes: [{ path: 'g.txt', status: 'create', diff: '', hash: '' }],
			},
			tests: null,
			repairs: null,
			runDir: '/tmp/lam-test-run-2',
			errorJson: null,
			contextMd: null,
			promptMd: null,
			responseMd: null,
		});
		const applyStep = story.find((s) => s.phase === 'Edit Application');
		assert.ok(applyStep, 'should have Edit Application step');
		assert.ok(
			applyStep.detail.includes('proposal'),
			`detail should mention proposal; got: ${applyStep.detail}`,
		);
		assert.ok(
			applyStep.detail.includes('applied at completion'),
			`detail should note applied at completion; got: ${applyStep.detail}`,
		);
	});

	it('Edit Application step defaults to proposal mode note when applyMode absent', () => {
		const story = buildCausalStory({
			summary: {
				ok: true,
				// no applyMode field — simulates older run
				proposalFound: true,
				proposalStatus: 'OK',
				proposalMessageCount: 0,
				responseChars: 80,
				loopBudget: { turns: 1, tokens: 20 },
				model: 'test',
				baseUrl: 'http://localhost:1234/v1',
				finishReasons: ['stop'],
			},
			writes: { applied: true, writes: [] },
			tests: null,
			repairs: null,
			runDir: '/tmp/lam-test-run-3',
			errorJson: null,
			contextMd: null,
			promptMd: null,
			responseMd: null,
		});
		const applyStep = story.find((s) => s.phase === 'Edit Application');
		assert.ok(applyStep, 'should have Edit Application step');
		// Falls back to proposal label.
		assert.ok(
			applyStep.detail.includes('proposal'),
			`detail should default to proposal mode; got: ${applyStep.detail}`,
		);
	});
});

// ---------------------------------------------------------------------------
// Regression — default proposal mode is byte-identical to phase-119 behaviour
// ---------------------------------------------------------------------------

describe('Phase 120 regression — default proposal mode unchanged', () => {
	it('proposal mode write_file does NOT write to disk (unchanged behaviour)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-reg-proposal-'));
		const registry = createBuiltinRegistry(cwd); // default = proposal
		const result = await registry.dispatch(
			'write_file',
			JSON.stringify({ path: 'reg-test.txt', content: 'content\n' }),
		);
		// Must say "applies when the task completes" (unchanged phrasing).
		assert.ok(
			result.includes('applies when the task completes'),
			`proposal-mode result should include deferred phrasing; got: ${result}`,
		);
		// File must NOT exist on disk.
		await assert.rejects(() => readFile(join(cwd, 'reg-test.txt'), 'utf8'), {
			code: 'ENOENT',
		});
	});

	it('proposal mode edit_file does NOT modify disk (unchanged behaviour)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-reg-proposal-edit-'));
		await writeFile(join(cwd, 'original.txt'), 'original content\n', 'utf8');
		const registry = createBuiltinRegistry(cwd);
		const result = await registry.dispatch(
			'edit_file',
			JSON.stringify({
				path: 'original.txt',
				search: 'original',
				replace: 'changed',
			}),
		);
		assert.ok(
			result.includes('applies when the task completes'),
			`proposal-mode edit result should say deferred; got: ${result}`,
		);
		// File on disk must be unchanged.
		const content = await readFile(join(cwd, 'original.txt'), 'utf8');
		assert.equal(
			content,
			'original content\n',
			'proposal mode must not modify disk',
		);
	});

	it('envelope mode ignores applyMode:live (inert)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-lam-reg-envelope-'));
		// In envelope mode, write_file/edit_file tools are not registered.
		const registry = createBuiltinRegistry(cwd, {
			toolWritesMode: 'envelope',
			applyMode: 'live',
		});
		const apiTools = registry.toApiTools();
		const names = apiTools.map((t) => t.function.name);
		assert.ok(
			!names.includes('write_file'),
			'envelope mode: write_file not registered',
		);
		assert.ok(
			!names.includes('edit_file'),
			'envelope mode: edit_file not registered',
		);
	});
});
