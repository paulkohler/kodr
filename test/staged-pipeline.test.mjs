import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { handleChannelRequest, main, parseArgs, VERSION } from '../src/app.mjs';
import { startFakeModelServer } from '../test-support/fake-model-server.mjs';

function proposalResponse(value) {
	return proposalResponseText(JSON.stringify(value));
}

function proposalResponseText(content) {
	return {
		choices: [
			{
				finish_reason: 'stop',
				message: {
					content,
					role: 'assistant',
				},
			},
		],
		id: 'chatcmpl_proposal',
		object: 'chat.completion',
	};
}

// Helper: build a minimal tool_calls response for write_file.
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

// Helper: build a plain-text stop turn.
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

// Helper: build a stop turn whose content is an envelope JSON.
function makeEnvelopeTurn(envelopeObj, chatId = 'chatcmpl_env') {
	return makeStopTurn(JSON.stringify(envelopeObj), chatId);
}

// Helper: write a model-profiles.json that sets toolWrites:native for 'test-model'.
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
// Phase 216 — runStagedPrompt SafeWriteError steering
// ---------------------------------------------------------------------------

describe('runStagedPrompt SafeWriteError steering (Phase 216)', () => {
	it('stage 2 SafeWriteError continues loop with steering note, does not break', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p216-steer-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/answer.mjs","done"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write a new file — lands on disk.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 42;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'Wrote answer.mjs.', level: 'info' }],
						scratchpad: '{"done":["create src/answer.mjs"],"next":"done"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: tries to overwrite the same file via files[] → SafeWriteError.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 99;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'Fixed answer.mjs.', level: 'info' }],
						scratchpad: '{"done":["create src/answer.mjs"],"next":"done"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: returns STAGED_DONE — loop should reach here.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["all"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p216-steer-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p216-steer-out', 'summary.json'), 'utf8'),
			);

			// Stage 2 SafeWriteError must not propagate as writeError — loop should continue.
			assert.ok(
				!summary.writeError || summary.writeError?.name !== 'SafeWriteError',
				`Stage 2 SafeWriteError should not be fatal, got: ${summary.writeError?.name}`,
			);
			// Stage 2 record must carry safeWriteSteer:true.
			const stage2 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-2',
			);
			assert.ok(stage2, 'implement-2 stage record must exist');
			assert.equal(
				stage2.safeWriteSteer,
				true,
				'implement-2 must have safeWriteSteer:true',
			);
			// Stage 3 request body must include the steering note.
			const stage3Request = server.recordings.find((r) =>
				(r.requestBody?.messages ?? []).some(
					(m) =>
						typeof m.content === 'string' && m.content.includes('Harness note'),
				),
			);
			assert.ok(stage3Request, 'stage 3 prompt must contain Harness note');
		} finally {
			await server.close();
		}
	});

	it('stage 1 SafeWriteError still breaks the loop', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p216-stage1-'));
		// Pre-create the file so stage 1 hits SafeWriteError immediately.
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'existing.mjs'), 'export const x = 1;\n');

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["overwrite src/existing.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: tries to overwrite the pre-existing file via files[].
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const x = 99;\n',
								path: 'src/existing.mjs',
							},
						],
						messages: [{ content: 'Overwrote existing.mjs.', level: 'info' }],
						scratchpad: '',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Overwrite src/existing.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p216-stage1-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p216-stage1-out', 'summary.json'), 'utf8'),
			);

			// Stage 1 SafeWriteError must propagate as a fatal writeError.
			assert.equal(
				summary.writeError?.name,
				'SafeWriteError',
				`expected SafeWriteError, got: ${summary.writeError?.name}`,
			);
		} finally {
			await server.close();
		}
	});
});

// Phase 224 — runStagedPrompt zero-new-write auto-advance
// ---------------------------------------------------------------------------

describe('runStagedPrompt zero-new-write auto-advance (Phase 224)', () => {
	it('safeWriteSteer then zero-write stage auto-completes without STAGED_DONE', async () => {
		// Stage 1 writes new src/answer.mjs (applies).
		// Stage 2 re-writes it via files[] → SafeWriteError → safeWriteSteer.
		// Stage 3 returns zero files with no STAGED_DONE messages.
		// Expected: harness treats stage 3 as implicitDone; staged.done===true; no StagedIncompleteError.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p224-steer-zero-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write new file — applies.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 42;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'Wrote answer.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: re-writes via files[] → SafeWriteError → steer fires.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 99;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'Update answer.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: zero files, no STAGED_DONE — harness must auto-complete.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'All looks good.', level: 'info' }],
						scratchpad: '{"done":["src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p224-steer-zero-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(
					join(cwd, 'p224-steer-zero-out', 'summary.json'),
					'utf8',
				),
			);

			// No StagedIncompleteError.
			assert.ok(
				!summary.writeError ||
					summary.writeError?.name !== 'StagedIncompleteError',
				`Should not produce StagedIncompleteError, got: ${summary.writeError?.name}`,
			);
			// staged.done must be true.
			assert.equal(summary.staged?.done, true, 'staged.done must be true');
			// implement-3 must carry implicitDone:true.
			const stage3 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-3',
			);
			assert.ok(stage3, 'implement-3 stage record must exist');
			assert.equal(
				stage3.implicitDone,
				true,
				'implement-3 must have implicitDone:true',
			);
			// src/answer.mjs must contain stage-1 content (stage-2 steer did not overwrite).
			const content = await readFile(join(cwd, 'src', 'answer.mjs'), 'utf8');
			assert.equal(
				content,
				'export const answer = 42;\n',
				'src/answer.mjs must keep stage-1 content',
			);
			// Loop must not have reached maxExecutionStages.
			const stageCount = summary.staged?.stages?.length ?? 0;
			assert.ok(
				stageCount < (summary.staged?.maxExecutionStages ?? 8) + 1,
				`stages count (${stageCount}) should be below the cap`,
			);
		} finally {
			await server.close();
		}
	});

	it('two consecutive safeWriteSteer stages auto-complete (second steer triggers implicitDone)', async () => {
		// Stage 1 writes new src/a.mjs.
		// Stage 2 re-writes via files[] → first steer (safeWriteSteered=true).
		// Stage 3 re-writes via files[] again → second steer → implicitDone triggered immediately.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p224-dbl-steer-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write new file.
				{
					body: proposalResponse({
						files: [{ content: 'export const a = 1;\n', path: 'src/a.mjs' }],
						messages: [{ content: 'Wrote a.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: re-writes via files[] → first steer.
				{
					body: proposalResponse({
						files: [{ content: 'export const a = 2;\n', path: 'src/a.mjs' }],
						messages: [{ content: 'Update a.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: re-writes via files[] again → second steer → implicitDone.
				{
					body: proposalResponse({
						files: [{ content: 'export const a = 3;\n', path: 'src/a.mjs' }],
						messages: [{ content: 'Update a.mjs again.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/a.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p224-dbl-steer-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p224-dbl-steer-out', 'summary.json'), 'utf8'),
			);

			// No StagedIncompleteError.
			assert.ok(
				!summary.writeError ||
					summary.writeError?.name !== 'StagedIncompleteError',
				`Should not produce StagedIncompleteError, got: ${summary.writeError?.name}`,
			);
			// implement-2 must have safeWriteSteer:true.
			const stage2 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-2',
			);
			assert.ok(stage2, 'implement-2 stage record must exist');
			assert.equal(
				stage2.safeWriteSteer,
				true,
				'implement-2 must have safeWriteSteer:true',
			);
			// implement-3 must have implicitDone:true.
			const stage3 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-3',
			);
			assert.ok(stage3, 'implement-3 stage record must exist');
			assert.equal(
				stage3.implicitDone,
				true,
				'implement-3 must have implicitDone:true',
			);
			// The double-steer path must complete: staged.done must be true so the
			// post-loop StagedIncompleteError synthesis stays gated.
			assert.equal(
				summary.staged?.done,
				true,
				'staged.done must be true for double-steer implicit completion',
			);
			// Neither steered stage may overwrite the file: src/a.mjs keeps stage-1 content.
			assert.equal(
				await readFile(join(cwd, 'src', 'a.mjs'), 'utf8'),
				'export const a = 1;\n',
				'src/a.mjs must keep the stage-1 content (steered overwrites never apply)',
			);
		} finally {
			await server.close();
		}
	});

	it('real write between steers resets flag — does NOT auto-complete on next zero-path stage', async () => {
		// Stage 1 writes src/a.mjs.
		// Stage 2 re-writes it → steer (safeWriteSteered=true).
		// Stage 3 writes new src/b.mjs → real write resets flag (safeWriteSteered=false).
		// Stage 4 returns zero paths, no STAGED_DONE.
		// Expected: stage 4 is noProgress:true (not implicitDone), src/b.mjs exists.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p224-reset-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/a.mjs","create src/b.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write src/a.mjs.
				{
					body: proposalResponse({
						files: [{ content: 'export const a = 1;\n', path: 'src/a.mjs' }],
						messages: [{ content: 'Wrote a.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: re-writes src/a.mjs via files[] → steer.
				{
					body: proposalResponse({
						files: [{ content: 'export const a = 2;\n', path: 'src/a.mjs' }],
						messages: [{ content: 'Update a.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: write new src/b.mjs → real write resets safeWriteSteered.
				{
					body: proposalResponse({
						files: [{ content: 'export const b = 2;\n', path: 'src/b.mjs' }],
						messages: [{ content: 'Wrote b.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs","src/b.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 4: zero paths, no STAGED_DONE — flag was reset so NO implicitDone.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Nothing left.', level: 'info' }],
						scratchpad: '{"done":["all"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 5: STAGED_DONE to cleanly exit (avoid StagedIncompleteError from cap).
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["all"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/a.mjs and src/b.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p224-reset-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p224-reset-out', 'summary.json'), 'utf8'),
			);

			// Stage 4 must be noProgress:true, NOT implicitDone.
			const stage4 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-4',
			);
			assert.ok(stage4, 'implement-4 stage record must exist');
			assert.equal(
				stage4.noProgress,
				true,
				'implement-4 must have noProgress:true',
			);
			assert.ok(!stage4.implicitDone, 'implement-4 must NOT have implicitDone');
			// src/b.mjs must exist (stage 3 applied).
			const bContent = await readFile(join(cwd, 'src', 'b.mjs'), 'utf8');
			assert.equal(
				bContent,
				'export const b = 2;\n',
				'src/b.mjs must exist with stage-3 content',
			);
		} finally {
			await server.close();
		}
	});

	it('zero-write stage with no prior steer records noProgress, not implicitDone', async () => {
		// Stage 1 returns zero paths, no STAGED_DONE, no prior steer.
		// Expected: noProgress:true, no implicitDone, done stays false.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p224-no-prior-steer-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create something"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: zero paths, no STAGED_DONE, no prior steer.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Thinking...', level: 'info' }],
						scratchpad: '{"plan":["create something"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: STAGED_DONE to cleanly exit (avoids StagedIncompleteError).
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create something',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p224-no-prior-steer-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(
					join(cwd, 'p224-no-prior-steer-out', 'summary.json'),
					'utf8',
				),
			);

			// Stage 1 must be noProgress:true, NOT implicitDone.
			const stage1 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-1',
			);
			assert.ok(stage1, 'implement-1 stage record must exist');
			assert.equal(
				stage1.noProgress,
				true,
				'implement-1 must have noProgress:true',
			);
			assert.ok(!stage1.implicitDone, 'implement-1 must NOT have implicitDone');
		} finally {
			await server.close();
		}
	});
});

// Phase 225 — runStagedPrompt zero-applied-write auto-advance
// ---------------------------------------------------------------------------

describe('runStagedPrompt zero-applied-write auto-advance (Phase 225)', () => {
	it('two consecutive no-op patch stages auto-complete (N=2)', async () => {
		// Plan; stage 1 writes new src/notes.mjs via files[].
		// Stages 2 and 3 emit patches[] for src/notes.mjs with a search string
		// that is absent from the file (zero applied writes each).
		// After streak=2, harness triggers implicitDone.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p225-two-noop-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/notes.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write new file — applies.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const notes = [];\n',
								path: 'src/notes.mjs',
							},
						],
						messages: [{ content: 'Wrote notes.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/notes.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: no-op patch (search string absent) — zero applied writes.
				{
					body: proposalResponse({
						patches: [
							{
								path: 'src/notes.mjs',
								replace:
									'export const notes = [];\nexport const VERSION = 1;\n',
								search: 'DOES_NOT_EXIST_IN_FILE',
							},
						],
						messages: [{ content: 'Patch notes.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/notes.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: another no-op patch — streak hits 2 → implicitDone.
				{
					body: proposalResponse({
						patches: [
							{
								path: 'src/notes.mjs',
								replace:
									'export const notes = [];\nexport const READY = true;\n',
								search: 'ALSO_DOES_NOT_EXIST',
							},
						],
						messages: [{ content: 'Another patch.', level: 'info' }],
						scratchpad: '{"done":["src/notes.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/notes.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p225-two-noop-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p225-two-noop-out', 'summary.json'), 'utf8'),
			);

			// No StagedIncompleteError.
			assert.ok(
				!summary.writeError ||
					summary.writeError?.name !== 'StagedIncompleteError',
				`Should not produce StagedIncompleteError, got: ${summary.writeError?.name}`,
			);
			// staged.done must be true.
			assert.equal(summary.staged?.done, true, 'staged.done must be true');
			// implement-3 must carry implicitDone:true with zero applied.
			const stage3 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-3',
			);
			assert.ok(stage3, 'implement-3 stage record must exist');
			assert.equal(
				stage3.implicitDone,
				true,
				'implement-3 must have implicitDone:true',
			);
			assert.equal(stage3.writeCount, 0, 'implement-3 writeCount must be 0');
			assert.deepEqual(
				stage3.appliedPaths,
				[],
				'implement-3 appliedPaths must be []',
			);
			assert.deepEqual(
				stage3.proposedPaths,
				['src/notes.mjs'],
				'implement-3 proposedPaths must be [src/notes.mjs]',
			);
			// The first zero-applied stage must be a nudge (noProgress), not done.
			const stage2 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-2',
			);
			assert.ok(stage2, 'implement-2 stage record must exist');
			assert.equal(stage2.noProgress, true, 'implement-2 must be noProgress');
			assert.equal(stage2.writeCount, 0, 'implement-2 writeCount must be 0');
			assert.ok(!stage2.implicitDone, 'implement-2 must not be implicitDone');
			// Implicit completion with applied writes and no test still surfaces
			// StagedUnverifiedError (parity with explicit STAGED_DONE).
			assert.equal(
				summary.runError?.name,
				'StagedUnverifiedError',
				'implicit-done run with writes and no test must surface StagedUnverifiedError',
			);
			// Loop must not have reached the cap.
			const stageCount = summary.staged?.stages?.length ?? 0;
			assert.ok(
				stageCount < (summary.staged?.maxExecutionStages ?? 8) + 1,
				`stages count (${stageCount}) should be below the cap`,
			);
			// Stage-1 content must be on disk.
			const content = await readFile(join(cwd, 'src', 'notes.mjs'), 'utf8');
			assert.equal(
				content,
				'export const notes = [];\n',
				'src/notes.mjs must keep stage-1 content',
			);
		} finally {
			await server.close();
		}
	});

	it('single no-op stage gets the nudge, does NOT auto-complete', async () => {
		// Plan; stage 1 writes src/a.mjs; stage 2 emits a no-op patch (streak=1,
		// nudge fires); stage 3 writes new src/b.mjs (resets noProgressTurns);
		// stage 4 emits STAGED_DONE to exit cleanly.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p225-one-noop-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["src/a.mjs","src/b.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write src/a.mjs.
				{
					body: proposalResponse({
						files: [{ content: 'export const a = 1;\n', path: 'src/a.mjs' }],
						messages: [{ content: 'Wrote a.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: no-op patch (streak=1) — nudge fires, no implicitDone.
				{
					body: proposalResponse({
						patches: [
							{
								path: 'src/a.mjs',
								replace: 'export const a = 99;\n',
								search: 'MISSING_STRING',
							},
						],
						messages: [{ content: 'Try to patch a.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: write new src/b.mjs — resets noProgressTurns.
				{
					body: proposalResponse({
						files: [{ content: 'export const b = 2;\n', path: 'src/b.mjs' }],
						messages: [{ content: 'Wrote b.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/a.mjs","src/b.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 4: STAGED_DONE to exit cleanly.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["all"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/a.mjs and src/b.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p225-one-noop-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p225-one-noop-out', 'summary.json'), 'utf8'),
			);

			// implement-2 must be noProgress:true, no implicitDone.
			const stage2 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-2',
			);
			assert.ok(stage2, 'implement-2 stage record must exist');
			assert.equal(
				stage2.noProgress,
				true,
				'implement-2 must have noProgress:true',
			);
			assert.equal(stage2.writeCount, 0, 'implement-2 writeCount must be 0');
			assert.ok(!stage2.implicitDone, 'implement-2 must NOT have implicitDone');
			// Stage 3 request body must contain the corrective nudge text.
			const stage3Request = server.recordings.find((r) =>
				(r.requestBody?.messages ?? []).some(
					(m) =>
						typeof m.content === 'string' &&
						m.content.includes('No-progress feedback'),
				),
			);
			assert.ok(
				stage3Request,
				'stage 3 prompt must contain No-progress feedback nudge',
			);
			// src/b.mjs must exist (stage 3 applied).
			const bContent = await readFile(join(cwd, 'src', 'b.mjs'), 'utf8');
			assert.equal(bContent, 'export const b = 2;\n', 'src/b.mjs must exist');
			// No StagedIncompleteError.
			assert.ok(
				!summary.writeError ||
					summary.writeError?.name !== 'StagedIncompleteError',
				`Should not produce StagedIncompleteError, got: ${summary.writeError?.name}`,
			);
		} finally {
			await server.close();
		}
	});

	it('no-op patches with NO prior real write do not false-complete', async () => {
		// Plan; stages 1 and 2 both emit no-op patches on a pre-created file.
		// allWrites.length === 0 throughout, so the gate never fires.
		// Expected: staged.done === false; StagedIncompleteError.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p225-no-prior-'));
		// Pre-create the file so the patch proposal finds a target but can't match.
		await mkdir(join(cwd, 'src'), { recursive: true });
		await writeFile(join(cwd, 'src', 'preexist.mjs'), 'export const x = 0;\n');

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["patch src/preexist.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: no-op patch (allWrites empty — gate blocked).
				{
					body: proposalResponse({
						patches: [
							{
								path: 'src/preexist.mjs',
								replace: 'export const x = 1;\n',
								search: 'MISSING_FROM_FILE',
							},
						],
						messages: [{ content: 'Patch preexist.', level: 'info' }],
						scratchpad: '{"done":[]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: another no-op patch — streak=2 but gate still blocked.
				{
					body: proposalResponse({
						patches: [
							{
								path: 'src/preexist.mjs',
								replace: 'export const x = 2;\n',
								search: 'ALSO_MISSING',
							},
						],
						messages: [{ content: 'Another patch.', level: 'info' }],
						scratchpad: '{"done":[]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stages 3-7: also no-op patches to exhaust the budget without STAGED_DONE.
				...Array.from({ length: 6 }, (_, i) => ({
					body: proposalResponse({
						patches: [
							{
								path: 'src/preexist.mjs',
								replace: `export const x = ${i + 3};\n`,
								search: `NO_MATCH_${i}`,
							},
						],
						messages: [{ content: `Stage ${i + 3}.`, level: 'info' }],
						scratchpad: '{"done":[]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				})),
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Patch src/preexist.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p225-no-prior-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p225-no-prior-out', 'summary.json'), 'utf8'),
			);

			// staged.done must be false — allWrites gate blocked implicitDone.
			assert.equal(summary.staged?.done, false, 'staged.done must be false');
			// No implicitDone in any stage record.
			const hasImplicit = (summary.staged?.stages ?? []).some(
				(s) => s.implicitDone,
			);
			assert.ok(
				!hasImplicit,
				'No stage should have implicitDone when no prior real writes',
			);
			// Falls to StagedIncompleteError.
			assert.equal(
				summary.writeError?.name,
				'StagedIncompleteError',
				`expected StagedIncompleteError, got: ${summary.writeError?.name}`,
			);
		} finally {
			await server.close();
		}
	});

	it('phase-224 regression: steer arm still auto-completes (proposedPaths/appliedPaths rename)', async () => {
		// Stage 1 writes new src/answer.mjs; stage 2 re-writes via files[] →
		// SafeWriteError → safeWriteSteer; stage 3 zero proposed paths, no STAGED_DONE
		// → phase-224 implicitDone. Also verifies the renamed forensics fields.
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p225-regression-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write new file — applies.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 42;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'Wrote answer.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: re-writes via files[] → SafeWriteError → steer.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 99;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'Update answer.mjs.', level: 'info' }],
						scratchpad: '{"done":["src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: zero files, no STAGED_DONE → phase-224 implicitDone.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'All looks good.', level: 'info' }],
						scratchpad: '{"done":["src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p225-regression-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(
					join(cwd, 'p225-regression-out', 'summary.json'),
					'utf8',
				),
			);

			// No StagedIncompleteError.
			assert.ok(
				!summary.writeError ||
					summary.writeError?.name !== 'StagedIncompleteError',
				`Should not produce StagedIncompleteError, got: ${summary.writeError?.name}`,
			);
			// staged.done must be true.
			assert.equal(summary.staged?.done, true, 'staged.done must be true');
			// implement-2 must carry safeWriteSteer:true + forensics fields.
			const stage2 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-2',
			);
			assert.ok(stage2, 'implement-2 stage record must exist');
			assert.equal(
				stage2.safeWriteSteer,
				true,
				'implement-2 must have safeWriteSteer:true',
			);
			assert.deepEqual(
				stage2.appliedPaths,
				[],
				'implement-2 appliedPaths must be []',
			);
			assert.deepEqual(
				stage2.proposedPaths,
				['src/answer.mjs'],
				'implement-2 proposedPaths must be [src/answer.mjs]',
			);
			// implement-3 must carry implicitDone:true.
			const stage3 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-3',
			);
			assert.ok(stage3, 'implement-3 stage record must exist');
			assert.equal(
				stage3.implicitDone,
				true,
				'implement-3 must have implicitDone:true',
			);
			// src/answer.mjs must contain stage-1 content.
			const content = await readFile(join(cwd, 'src', 'answer.mjs'), 'utf8');
			assert.equal(
				content,
				'export const answer = 42;\n',
				'src/answer.mjs must keep stage-1 content',
			);
		} finally {
			await server.close();
		}
	});
});

// Phase 226 — duplicate-block guard: staged integration
// ---------------------------------------------------------------------------

describe('runStagedPrompt duplicate-block guard (Phase 226)', () => {
	it('case 6: stage that re-adds an existing block is rejected; construct appears once on disk', async () => {
		// Plan; stage 1 writes server.mjs with the listen guard once via files[].
		// Stage 2 emits an edit_file patch whose replace re-adds the guard (duplicate_block).
		// Stage 3 returns STAGED_DONE.
		// Assert: server.mjs on disk has the guard exactly once (no SyntaxError duplicate);
		// stage 2 has writeCount === 0 (phase-225 zero-applied arm).
		const LISTEN_GUARD = [
			'if (process.env.NODE_ENV !== "test") {',
			'  server.listen(port, () => {',
			'    console.log(`Listening on port ${port}`);',
			'  });',
			'}',
		].join('\n');

		// File written by stage 1: anchor + listen guard once.
		const serverMjsContent = `export let server;\nconst port = 3000;\n\n${LISTEN_GUARD}\n`;

		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p226-staged-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan: write server.mjs.', level: 'info' }],
						scratchpad: '{"plan":["write server.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write server.mjs with the listen guard once.
				{
					body: proposalResponse({
						files: [{ content: serverMjsContent, path: 'server.mjs' }],
						messages: [{ content: 'Wrote server.mjs.', level: 'info' }],
						scratchpad: '{"done":["server.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: patch whose replace = LISTEN_GUARD (duplicate_block → rejected).
				// search = anchor pair; replace = just the guard block.
				// After apply the guard would appear twice — guard rejects it.
				{
					body: proposalResponse({
						patches: [
							{
								path: 'server.mjs',
								search: 'export let server;\nconst port = 3000;',
								replace: LISTEN_GUARD,
							},
						],
						messages: [{ content: 'Add guard.', level: 'info' }],
						scratchpad: '{"done":["server.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 3: STAGED_DONE.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["server.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Write server.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p226-staged-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p226-staged-out', 'summary.json'), 'utf8'),
			);

			// Stage-2 must have writeCount === 0 (zero-applied: duplicate_block rejected).
			const stage2 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-2',
			);
			assert.ok(stage2, 'implement-2 stage record must exist');
			assert.equal(
				stage2.writeCount,
				0,
				'implement-2 must have writeCount === 0 (duplicate_block rejected)',
			);

			// server.mjs on disk must contain the guard exactly once.
			const onDisk = await readFile(join(cwd, 'server.mjs'), 'utf8');
			const blockCount = onDisk.split(LISTEN_GUARD).length - 1;
			assert.equal(
				blockCount,
				1,
				'listen guard must appear exactly once in server.mjs (no duplicate written)',
			);
		} finally {
			await server.close();
		}
	});
});

// Phase 215 — runStagedPrompt draft fallback
// ---------------------------------------------------------------------------

describe('Phase 215 — runStagedPrompt tool-channel draft fallback', () => {
	it('synthesises proposal from tool-channel draft when stage returns no JSON envelope', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p215-draft-fallback-'));
		// Write a native model profile so tool_calls are recognised.
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Stage 0: plan turn — return a scratchpad envelope.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad:
							'{"plan":["create src/answer.mjs"],"next":"create src/answer.mjs"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1 turn 1: model writes the file via write_file tool call.
				makeWriteFileTurn({
					id: 'call_p215',
					path: 'src/answer.mjs',
					content: 'export const answer = 42;\n',
					chatId: 'chatcmpl_p215_1',
				}),
				// Stage 1 turn 2: model returns plain stop with no JSON envelope.
				makeStopTurn('Done — wrote src/answer.mjs.', 'chatcmpl_p215_2'),
				// Stage 2: clearFiles (Phase 217) clears the draft after stage 1 applies.
				// Provide STAGED_DONE so the loop exits rather than hitting ProposalMissingError.
				makeEnvelopeTurn(
					{
						status: 'OK',
						files: [],
						patches: [],
						messages: [
							{ level: 'info', content: 'All files written. STAGED_DONE' },
						],
						scratchpad: '',
					},
					'chatcmpl_p215_3',
				),
			],
		});

		// Patch the native profile to use the real server's baseUrl.
		await writeNativeProfile(cwd, server.baseUrl);

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p215-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p215-out', 'summary.json'), 'utf8'),
			);

			// Draft fallback must have synthesised a proposal — no ProposalMissingError.
			assert.ok(
				!summary.writeError ||
					summary.writeError?.name !== 'ProposalMissingError',
				`must not be ProposalMissingError, got: ${summary.writeError?.name}`,
			);
			// The staged run wrote at least one file.
			assert.ok(
				summary.writeCount >= 1,
				`writeCount should be >= 1, got: ${summary.writeCount}`,
			);
		} finally {
			await server.close();
		}
	});

	it('still returns ProposalMissingError when draft is empty and no envelope', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p215-empty-draft-'));
		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Implementation stage: no tool calls, no JSON envelope — plain text only.
				makeStopTurn('I could not implement anything.', 'chatcmpl_p215_empty'),
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create something',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p215-empty-out',
					'--timeout-ms',
					'5000',
					'--tools',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p215-empty-out', 'summary.json'), 'utf8'),
			);

			// Empty draft + no envelope must still produce ProposalMissingError.
			assert.equal(
				summary.writeError?.name,
				'ProposalMissingError',
				`expected ProposalMissingError, got: ${summary.writeError?.name}`,
			);
		} finally {
			await server.close();
		}
	});
});
// Phase 221 — maxStageWrites raised to 8
// ---------------------------------------------------------------------------

describe('Phase 221 — runStagedPrompt maxStageWrites boundary', () => {
	it('staged proposal with exactly 8 file writes succeeds (no StagedProposalTooLargeError)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p221-8files-'));

		// Build a files array of exactly 8 files.
		const eightFiles = Array.from({ length: 8 }, (_, i) => ({
			content: `export const f${i} = ${i};\n`,
			path: `src/f${i}.mjs`,
		}));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["write 8 files"],"next":"write 8 files"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: 8 file writes — exactly at the limit.
				{
					body: proposalResponse({
						files: eightFiles,
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["write 8 files"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Write 8 files',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p221-8files-out',
					'--timeout-ms',
					'5000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p221-8files-out', 'summary.json'), 'utf8'),
			);

			// 8 files must not trigger StagedProposalTooLargeError.
			assert.notEqual(
				summary.writeError?.name,
				'StagedProposalTooLargeError',
				`unexpected StagedProposalTooLargeError at 8 files`,
			);
			assert.equal(summary.writeCount, 8);
		} finally {
			await server.close();
		}
	});

	it('staged proposal with 9 file writes throws StagedProposalTooLargeError', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p221-9files-'));

		// Build a files array of 9 files — one over the limit.
		const nineFiles = Array.from({ length: 9 }, (_, i) => ({
			content: `export const g${i} = ${i};\n`,
			path: `src/g${i}.mjs`,
		}));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["write 9 files"],"next":"write 9 files"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: 9 file writes — one over the limit.
				{
					body: proposalResponse({
						files: nineFiles,
						messages: [{ content: 'All files written.', level: 'info' }],
						scratchpad: '{"done":["write 9 files"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Write 9 files',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p221-9files-out',
					'--timeout-ms',
					'5000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p221-9files-out', 'summary.json'), 'utf8'),
			);

			// 9 files must trigger StagedProposalTooLargeError.
			assert.equal(
				summary.writeError?.name,
				'StagedProposalTooLargeError',
				`expected StagedProposalTooLargeError at 9 files, got: ${summary.writeError?.name}`,
			);
		} finally {
			await server.close();
		}
	});
});

// Phase 223 — StagedProposalTooLargeError path dedup
// ---------------------------------------------------------------------------

describe('Phase 223 — StagedProposalTooLargeError path dedup', () => {
	it('staged proposal with 9 ops on 6 unique paths does NOT throw StagedProposalTooLargeError', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p223-dedup-ok-'));

		// 6 unique paths but 9 total entries (3 paths appear twice).
		// proposalPaths returns all 9, but uniquePaths deduplicates to 6 — under the 8-limit.
		const sixUniquePaths = [
			'src/a.mjs',
			'src/b.mjs',
			'src/c.mjs',
			'src/d.mjs',
			'src/e.mjs',
			'src/f.mjs',
		];
		const nineOpsFiles = [
			...sixUniquePaths.map((path, i) => ({
				content: `export const v${i} = ${i};\n`,
				path,
			})),
			// 3 duplicates (same paths as a/b/c — second write wins)
			{ content: `export const va2 = 'updated';\n`, path: 'src/a.mjs' },
			{ content: `export const vb2 = 'updated';\n`, path: 'src/b.mjs' },
			{ content: `export const vc2 = 'updated';\n`, path: 'src/c.mjs' },
		];

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad:
							'{"plan":["write 6 unique files"],"next":"write files"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: 9 ops on 6 unique paths — must NOT trigger StagedProposalTooLargeError.
				{
					body: proposalResponse({
						files: nineOpsFiles,
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["write 6 unique files"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Write 6 unique files (9 total ops)',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p223-dedup-ok-out',
					'--timeout-ms',
					'5000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p223-dedup-ok-out', 'summary.json'), 'utf8'),
			);

			// 6 unique paths must NOT trigger StagedProposalTooLargeError.
			assert.notEqual(
				summary.writeError?.name,
				'StagedProposalTooLargeError',
				`unexpected StagedProposalTooLargeError at 6 unique paths (9 total ops)`,
			);
		} finally {
			await server.close();
		}
	});

	it('staged proposal with 9 ops on 9 unique paths DOES throw StagedProposalTooLargeError', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p223-dedup-err-'));

		// 9 unique paths — all distinct, so uniquePaths.length === 9 > 8 === maxStageWrites.
		const nineUniqueFiles = Array.from({ length: 9 }, (_, i) => ({
			content: `export const u${i} = ${i};\n`,
			path: `src/u${i}.mjs`,
		}));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad:
							'{"plan":["write 9 unique files"],"next":"write files"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: 9 unique paths — must trigger StagedProposalTooLargeError.
				{
					body: proposalResponse({
						files: nineUniqueFiles,
						messages: [{ content: 'All files written.', level: 'info' }],
						scratchpad: '{"done":["write 9 unique files"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Write 9 unique files',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p223-dedup-err-out',
					'--timeout-ms',
					'5000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p223-dedup-err-out', 'summary.json'), 'utf8'),
			);

			// 9 unique paths must trigger StagedProposalTooLargeError.
			assert.equal(
				summary.writeError?.name,
				'StagedProposalTooLargeError',
				`expected StagedProposalTooLargeError at 9 unique paths, got: ${summary.writeError?.name}`,
			);
		} finally {
			await server.close();
		}
	});
});

// Phase 222 — runStagedPrompt inter-stage npm install
// ---------------------------------------------------------------------------

describe('runStagedPrompt inter-stage npm install (Phase 222)', () => {
	it('triggers install between stage 1 and stage 2 when package.json applied and node_modules absent', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p222-install-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create package.json","done"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write package.json.
				{
					body: proposalResponse({
						files: [
							{
								content: '{"name":"test-pkg","version":"1.0.0"}\n',
								path: 'package.json',
							},
						],
						messages: [{ content: 'Wrote package.json.', level: 'info' }],
						scratchpad: '{"done":["create package.json"],"next":"done"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: STAGED_DONE.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["all"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		const installerCalls = [];
		try {
			const options = parseArgs([
				'run',
				'-p',
				'Create package.json',
				'--staged',
				'--base-url',
				server.baseUrl,
				'--out',
				'p222-install-out',
				'--timeout-ms',
				'10000',
				'--yes',
				'--json',
				'--install',
			]);
			// Inject a mock runner so npm is not actually invoked.
			options.installRunner = async (_cwd, parsed) => {
				installerCalls.push(`${parsed.bin} ${parsed.args.join(' ')}`);
				return {
					exitCode: 0,
					stderr: '',
					stdout: 'ok',
					timedOut: false,
				};
			};

			await handleChannelRequest(
				{ kind: 'run-turn', options },
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p222-install-out', 'summary.json'), 'utf8'),
			);

			// Must have at least one inter-stage install record.
			const interStageRecord = summary.staged?.stages?.find(
				(s) => s.interStageInstall === true,
			);
			assert.ok(
				interStageRecord,
				`expected an interStageInstall stageRecord, got stages: ${JSON.stringify(summary.staged?.stages)}`,
			);
			assert.equal(interStageRecord.ok, true);
			// The mock installer must have been called.
			assert.ok(
				installerCalls.length >= 1,
				`installRunner must be called at least once, got: ${installerCalls.length}`,
			);
		} finally {
			await server.close();
		}
	});

	it('skips inter-stage install when node_modules already exists', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p222-skip-nm-'));
		// Pre-create node_modules so the access() check succeeds.
		await mkdir(join(cwd, 'node_modules'), { recursive: true });

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["update package.json"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write package.json — but node_modules already exists.
				{
					body: proposalResponse({
						files: [
							{
								content: '{"name":"existing-pkg","version":"2.0.0"}\n',
								path: 'package.json',
							},
						],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["update package.json"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		const installerCalls = [];
		try {
			const options = parseArgs([
				'run',
				'-p',
				'Update package.json',
				'--staged',
				'--base-url',
				server.baseUrl,
				'--out',
				'p222-skip-nm-out',
				'--timeout-ms',
				'10000',
				'--yes',
				'--json',
				'--install',
			]);
			options.installRunner = async (_cwd, parsed) => {
				installerCalls.push(`${parsed.bin} ${parsed.args.join(' ')}`);
				return { exitCode: 0, stderr: '', stdout: 'ok', timedOut: false };
			};

			await handleChannelRequest(
				{ kind: 'run-turn', options },
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p222-skip-nm-out', 'summary.json'), 'utf8'),
			);

			// No inter-stage install record must appear.
			const interStageRecord = summary.staged?.stages?.find(
				(s) => s.interStageInstall === true,
			);
			assert.ok(
				!interStageRecord,
				`expected no interStageInstall record when node_modules exists, got: ${JSON.stringify(interStageRecord)}`,
			);
			// options.installRunner is only used by the inter-stage path
			// (runner: options.installRunner ?? commandRunner). The final-stage
			// install uses runner: commandRunner directly and does not go through
			// options.installRunner, so installerCalls tracks inter-stage calls only.
			assert.equal(
				installerCalls.length,
				0,
				`inter-stage installRunner must not be called when node_modules already exists`,
			);
		} finally {
			await server.close();
		}
	});

	it('skips inter-stage install when stage applies only non-package.json files', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p222-no-pkg-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/index.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write src/index.mjs only — no package.json.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const x = 1;\n',
								path: 'src/index.mjs',
							},
						],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["create src/index.mjs"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		const installerCalls = [];
		try {
			const options = parseArgs([
				'run',
				'-p',
				'Create src/index.mjs',
				'--staged',
				'--base-url',
				server.baseUrl,
				'--out',
				'p222-no-pkg-out',
				'--timeout-ms',
				'10000',
				'--yes',
				'--json',
				'--install',
			]);
			options.installRunner = async (_cwd, parsed) => {
				installerCalls.push(`${parsed.bin} ${parsed.args.join(' ')}`);
				return { exitCode: 0, stderr: '', stdout: 'ok', timedOut: false };
			};

			await handleChannelRequest(
				{ kind: 'run-turn', options },
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p222-no-pkg-out', 'summary.json'), 'utf8'),
			);

			// No inter-stage install record must appear.
			const interStageRecord = summary.staged?.stages?.find(
				(s) => s.interStageInstall === true,
			);
			assert.ok(
				!interStageRecord,
				`expected no interStageInstall when only non-package.json files applied, got: ${JSON.stringify(interStageRecord)}`,
			);
			// options.installRunner is only used by the inter-stage path. No
			// package.json was in the stage writes, so hasDependencyMetadataWrites
			// returns false and the inter-stage block is skipped entirely. The
			// final-stage install uses runner: commandRunner directly, not
			// options.installRunner, so installerCalls stays empty.
			assert.equal(
				installerCalls.length,
				0,
				`inter-stage installRunner must not be called when no package.json in writes, got ${installerCalls.length} calls`,
			);
		} finally {
			await server.close();
		}
	});

	it('sets writeError and breaks stage loop on install failure', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p222-fail-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create package.json","then more work"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: write package.json — install will fail.
				{
					body: proposalResponse({
						files: [
							{
								content: '{"name":"fail-pkg","version":"1.0.0"}\n',
								path: 'package.json',
							},
						],
						messages: [{ content: 'Wrote package.json.', level: 'info' }],
						scratchpad: '{"done":["create package.json"],"next":"more work"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 2: should never be reached (loop breaks on install failure).
				{
					body: proposalResponse({
						files: [{ content: 'export const y = 2;\n', path: 'src/y.mjs' }],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["more work"],"next":""}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const options = parseArgs([
				'run',
				'-p',
				'Create package.json',
				'--staged',
				'--base-url',
				server.baseUrl,
				'--out',
				'p222-fail-out',
				'--timeout-ms',
				'10000',
				'--yes',
				'--json',
				'--install',
			]);
			// Inject a failing runner.
			options.installRunner = async (_cwd, _parsed) => ({
				exitCode: 1,
				stderr: 'npm error: install failed',
				stdout: '',
				timedOut: false,
			});

			await handleChannelRequest(
				{ kind: 'run-turn', options },
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p222-fail-out', 'summary.json'), 'utf8'),
			);

			// writeError must be set with DependencyInstallError.
			assert.equal(
				summary.writeError?.name,
				'DependencyInstallError',
				`expected DependencyInstallError, got: ${summary.writeError?.name}`,
			);
			assert.match(
				summary.writeError?.message ?? '',
				/Inter-stage dependency install failed/u,
			);
			// The inter-stage install stageRecord with error must exist.
			const failRecord = summary.staged?.stages?.find(
				(s) => s.interStageInstall === true && s.error,
			);
			assert.ok(
				failRecord,
				`expected interStageInstall error record, got stages: ${JSON.stringify(summary.staged?.stages)}`,
			);
			// Stage 2 must NOT have been reached — server recorded only 2 requests
			// (plan + stage 1). Stage 2 response was never fetched.
			const requestCount = server.recordings.length;
			assert.ok(
				requestCount <= 2,
				`stage loop must break after install failure, got ${requestCount} requests`,
			);
		} finally {
			await server.close();
		}
	});
});

// Phase 233 — staged draft apply on STAGED_DONE (W4 parity)
// ---------------------------------------------------------------------------

describe('Phase 233 — staged W4-parity: apply pending draft writes on STAGED_DONE', () => {
	// (a) THE BUG — regression-proof: write_file turn + STAGED_DONE envelope in the
	// same stage must apply the pending draft write AND terminate the stage as done.
	// Pre-fix this FAILS (writeCount:0, file absent). Post-fix the file is applied.
	it('(a) draft write + STAGED_DONE files:[] — file IS applied AND stage is done', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p233-a-'));
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Plan turn — scratchpad envelope, no files.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad:
							'{"plan":["create src/server.test.mjs"],"next":"create src/server.test.mjs"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1 sub-turn 1: model writes the file via write_file tool call
				// (finish_reason=tool_calls). This populates proposalDraft.
				makeWriteFileTurn({
					id: 'call_p233a',
					path: 'src/server.test.mjs',
					content:
						'import assert from "node:assert/strict";\nassert.ok(true);\n',
					chatId: 'chatcmpl_p233a_1',
				}),
				// Stage 1 sub-turn 2: after the tool result the model returns a
				// STAGED_DONE envelope with files:[] (finish_reason=stop).
				// This is the exact pattern that caused silent data loss before phase 233:
				// the draft was non-empty, proposal was non-null (STAGED_DONE), the
				// old code skipped the W3 fallback, and paths.length===0 set done=true
				// without ever merging the draft write.
				makeEnvelopeTurn(
					{
						status: 'OK',
						files: [],
						patches: [],
						messages: [
							{
								level: 'info',
								content: 'All files written. STAGED_DONE',
							},
						],
						scratchpad: '',
					},
					'chatcmpl_p233a_2',
				),
			],
		});

		await writeNativeProfile(cwd, server.baseUrl);

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/server.test.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p233a-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p233a-out', 'summary.json'), 'utf8'),
			);

			// No writeError.
			assert.ok(
				!summary.writeError,
				`expected no writeError, got: ${summary.writeError?.name} — ${summary.writeError?.message}`,
			);
			// The draft write must have been applied (writeCount >= 1).
			assert.ok(
				summary.writeCount >= 1,
				`writeCount must be >= 1 (draft write applied), got: ${summary.writeCount}`,
			);
			// The file must exist on disk.
			const fileContent = await readFile(
				join(cwd, 'src', 'server.test.mjs'),
				'utf8',
			);
			assert.ok(
				fileContent.includes('assert.ok(true)'),
				`file content wrong: ${fileContent}`,
			);
			// The stage must be done (STAGED_DONE honored).
			const implementStage = summary.staged?.stages?.find(
				(s) => s.name === 'implement-1',
			);
			assert.ok(
				implementStage,
				`implement-1 stage record missing; stages: ${JSON.stringify(summary.staged?.stages)}`,
			);
			assert.equal(
				implementStage.writeCount,
				1,
				`implement-1 writeCount must be 1, got: ${implementStage.writeCount}`,
			);
		} finally {
			await server.close();
		}
	});

	// (b) Regression — STAGED_DONE with empty draft → done, writeCount 0.
	// Existing empty-paths branch still fires when there is no pending draft write.
	it('(b) STAGED_DONE with empty draft → done with writeCount 0 (regression guard)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p233-b-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["write src/x.mjs"],"next":"write src/x.mjs"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: pure STAGED_DONE envelope, no files, no draft writes.
				// Both the draft and the envelope are empty — paths.length===0.
				{
					body: proposalResponse({
						files: [],
						patches: [],
						messages: [{ level: 'info', content: 'All done. STAGED_DONE' }],
						scratchpad: '',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			await main(
				[
					'run',
					'-p',
					'Write src/x.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p233b-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p233b-out', 'summary.json'), 'utf8'),
			);

			// No writeError — STAGED_DONE is not an error.
			assert.ok(
				!summary.writeError,
				`expected no writeError, got: ${summary.writeError?.name}`,
			);
			// Zero writes (no draft, no envelope files).
			assert.equal(
				summary.writeCount,
				0,
				`writeCount must be 0 (no draft, no files), got: ${summary.writeCount}`,
			);
		} finally {
			await server.close();
		}
	});

	// (c) Union — draft file + envelope file, envelope wins on the overlapping path,
	// no double-count. Uses a native-profile run so the draft gets populated.
	it('(c) draft file + envelope file — envelope wins per path, single write, no double-count', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p233-c-'));
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad:
							'{"plan":["create src/config.mjs"],"next":"create src/config.mjs"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1 sub-turn 1: write src/config.mjs via write_file (draft version).
				makeWriteFileTurn({
					id: 'call_p233c',
					path: 'src/config.mjs',
					content: 'export const config = { version: 1 };\n',
					chatId: 'chatcmpl_p233c_1',
				}),
				// Stage 1 sub-turn 2: envelope also includes src/config.mjs (envelope wins)
				// PLUS a second file src/index.mjs, AND signals STAGED_DONE.
				makeEnvelopeTurn(
					{
						status: 'OK',
						files: [
							{
								path: 'src/config.mjs',
								content: 'export const config = { version: 2 };\n',
							},
							{
								path: 'src/index.mjs',
								content: 'export { config } from "./config.mjs";\n',
							},
						],
						patches: [],
						messages: [
							{ level: 'info', content: 'Files written. STAGED_DONE' },
						],
						scratchpad: '',
					},
					'chatcmpl_p233c_2',
				),
			],
		});

		await writeNativeProfile(cwd, server.baseUrl);

		try {
			await main(
				[
					'run',
					'-p',
					'Create src/config.mjs and src/index.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p233c-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p233c-out', 'summary.json'), 'utf8'),
			);

			// No writeError.
			assert.ok(
				!summary.writeError,
				`expected no writeError, got: ${summary.writeError?.name} — ${summary.writeError?.message}`,
			);
			// Exactly 2 unique files written (no double-count on src/config.mjs).
			assert.equal(
				summary.writeCount,
				2,
				`writeCount must be 2 (config.mjs + index.mjs), got: ${summary.writeCount}`,
			);
			// Envelope version wins for src/config.mjs (version: 2, not version: 1).
			const configContent = await readFile(
				join(cwd, 'src', 'config.mjs'),
				'utf8',
			);
			assert.ok(
				configContent.includes('version: 2'),
				`envelope must win for config.mjs, got: ${configContent}`,
			);
			// src/index.mjs written from envelope.
			const indexContent = await readFile(
				join(cwd, 'src', 'index.mjs'),
				'utf8',
			);
			assert.ok(
				indexContent.includes('config'),
				`index.mjs must be written, got: ${indexContent}`,
			);
		} finally {
			await server.close();
		}
	});

	// NOTE: Test case (d) — no-op byte-identical write + STAGED_DONE → writeCount 0.
	// DROPPED: prepareChanges with apply:true always writes the file (no content
	// comparison gate); a byte-identical re-write is not a no-op in the current
	// harness (writeResult.writes.length > 0 even when content is unchanged).
	// The zero-applied path (phase 225) requires that preparePatches/prepareWrites
	// produce zero writes (e.g. a patch whose search string is absent), which is
	// distinct from the phase-233 change 4 scenario. The harness cannot produce a
	// zero-write result from a full file write with any content, so case (d) cannot
	// be exercised by the fake-model-server integration harness. Coverage of change 4
	// is provided by changes 1-3 in case (a) (the merged proposal's paths are
	// non-empty, so the phase-225 auto-advance fires only when prepareChanges truly
	// returns zero writes; stagedDoneSignal short-circuits before that in the
	// STAGED_DONE case).

	// (e) Normal (non-STAGED_DONE) stage: a draft write_file PLUS a non-overlapping
	// envelope file are BOTH applied (W4 parity for the ordinary case, not only the
	// STAGED_DONE one). Pre-233 the staged path ignored the draft whenever the
	// envelope was non-null, so the draft-only file would have been lost here too.
	// The stage does NOT signal STAGED_DONE, so it continues; a second stage then
	// completes the run. Documents the behavior change the phase-233 review flagged.
	it('(e) non-STAGED_DONE stage merges a draft file alongside the envelope file', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p233-e-'));
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad:
							'{"plan":["write src/draftonly.mjs and src/envonly.mjs"],"next":"write both files"}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// implement-1 sub-turn 1: write src/draftonly.mjs via write_file (draft).
				makeWriteFileTurn({
					id: 'call_p233e',
					path: 'src/draftonly.mjs',
					content: 'export const fromDraft = true;\n',
					chatId: 'chatcmpl_p233e_1',
				}),
				// implement-1 sub-turn 2: envelope lists ONLY src/envonly.mjs and does
				// NOT signal STAGED_DONE. The draft's src/draftonly.mjs must still be
				// merged + applied (W4), and the stage continues (done stays false).
				makeEnvelopeTurn(
					{
						status: 'OK',
						files: [
							{
								path: 'src/envonly.mjs',
								content: 'export const fromEnvelope = true;\n',
							},
						],
						patches: [],
						messages: [{ level: 'info', content: 'Wrote both files.' }],
						scratchpad: '',
					},
					'chatcmpl_p233e_2',
				),
				// implement-2: STAGED_DONE to terminate the run.
				{
					body: proposalResponse({
						files: [],
						patches: [],
						messages: [{ level: 'info', content: 'All done. STAGED_DONE' }],
						scratchpad: '',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		await writeNativeProfile(cwd, server.baseUrl);

		try {
			await main(
				[
					'run',
					'-p',
					'Write src/draftonly.mjs and src/envonly.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p233e-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			// Both files must be on disk — the draft-only file is NOT lost just because
			// the envelope omitted it.
			const draftContent = await readFile(
				join(cwd, 'src', 'draftonly.mjs'),
				'utf8',
			);
			assert.ok(
				draftContent.includes('fromDraft'),
				`draft-only file must be applied, got: ${draftContent}`,
			);
			const envContent = await readFile(
				join(cwd, 'src', 'envonly.mjs'),
				'utf8',
			);
			assert.ok(
				envContent.includes('fromEnvelope'),
				`envelope file must be applied, got: ${envContent}`,
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p233e-out', 'summary.json'), 'utf8'),
			);
			assert.ok(
				!summary.writeError,
				`expected no writeError, got: ${summary.writeError?.name}`,
			);
			// implement-1 applied both files (draft + envelope), no double-count.
			const stage1 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-1',
			);
			assert.equal(
				stage1?.writeCount,
				2,
				`implement-1 must apply 2 files, got: ${stage1?.writeCount}`,
			);
		} finally {
			await server.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Phase 235 — Clear the Proposal Draft Before Each Heal Turn (Stale Carryover Fix)
// ---------------------------------------------------------------------------

describe('Phase 235 — heal draft carryover (stale no-op write suppression)', () => {
	// Helper: build a length-finish turn (no write_file, no content — the runaway pattern).
	function makeLengthTurn(chatId = 'chatcmpl_len') {
		return {
			body: {
				choices: [
					{
						finish_reason: 'length',
						message: { content: '', role: 'assistant' },
					},
				],
				id: chatId,
				object: 'chat.completion',
				usage: {
					completion_tokens: 4096,
					prompt_tokens: 11075,
					total_tokens: 15171,
				},
			},
			method: 'POST',
			status: 200,
			url: '/v1/chat/completions',
		};
	}

	// (a) THE BUG — main run writes file A (applied); heal turn is read-only (stop,
	// no write_file). After fix: heal writes.json must NOT re-emit file A as a no-op.
	// Pre-fix: file A re-emitted with empty diff and real content hash.
	it('(a) stale main-run write NOT re-emitted in heal turn proposal', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p235-a-'));
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Main run turn 1: write_file creates src/broken.mjs (broken syntax).
				makeWriteFileTurn({
					id: 'call_p235a_1',
					path: 'src/broken.mjs',
					content: 'export const broken = ;\n',
					chatId: 'chatcmpl_p235a_1',
				}),
				// Main run turn 2: stop — model done.
				makeStopTurn('Wrote src/broken.mjs.', 'chatcmpl_p235a_2'),
				// Heal turn 1: read-only, no write_file. The model just says something.
				// After fix: the stale draft (src/broken.mjs) must be cleared before this.
				makeStopTurn(
					'I read the file but cannot fix it here.',
					'chatcmpl_p235a_heal',
				),
			],
		});

		await writeNativeProfile(cwd, server.baseUrl);

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/broken.mjs',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p235a-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--test',
					'node --check src/broken.mjs',
					'--heal',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			// The main run created a broken file → heal should have engaged.
			assert.ok(result.result.runDir, 'runDir must be present');

			// Read heal writes.json for turn-1.
			const writesPath = join(
				result.result.runDir,
				'repairs',
				'turn-1',
				'writes.json',
			);
			let writesJson;
			try {
				writesJson = JSON.parse(await readFile(writesPath, 'utf8'));
			} catch {
				// If writes.json doesn't exist, the heal turn produced no writes — correct.
				writesJson = { files: [] };
			}

			// The heal turn must NOT have re-emitted src/broken.mjs as a no-op write.
			// Pre-fix: writesJson.files contains src/broken.mjs with empty diff.
			// Post-fix: writesJson.files is empty or does not contain src/broken.mjs.
			const staleFiles = (writesJson.files ?? []).filter(
				(f) => f.path === 'src/broken.mjs' || f.path?.includes('broken'),
			);
			assert.equal(
				staleFiles.length,
				0,
				`heal turn must NOT re-emit stale main-run file; got: ${JSON.stringify(staleFiles)}`,
			);
		} finally {
			await server.close();
		}
	});

	// (b) Restored phase-231 accuracy — heal turn with finish_reason:length + empty text
	// + a stale (pre-populated) main draft now classifies 'reasoning_runaway'.
	// Pre-fix: draft is non-empty → proposalNonEmpty=true → isReasoningRunaway returns false
	// → no-progress-exhausted. Post-fix: draft cleared → proposalNonEmpty=false → runaway fired.
	it('(b) runaway heal turn classifies reasoning_runaway after draft cleared', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p235-b-'));
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Main run: write_file creates src/broken2.mjs (broken syntax).
				makeWriteFileTurn({
					id: 'call_p235b_1',
					path: 'src/broken2.mjs',
					content: 'export const broken = ;\n',
					chatId: 'chatcmpl_p235b_1',
				}),
				// Main run: stop.
				makeStopTurn('Wrote src/broken2.mjs.', 'chatcmpl_p235b_2'),
				// Heal turn 1: finish_reason=length, empty content — the runaway pattern.
				// Pre-fix: stale draft → proposalNonEmpty=true → runaway suppressed.
				// Post-fix: draft cleared → proposalNonEmpty=false → reasoning_runaway.
				makeLengthTurn('chatcmpl_p235b_heal'),
			],
		});

		await writeNativeProfile(cwd, server.baseUrl);

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/broken2.mjs',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p235b-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--test',
					'node --check src/broken2.mjs',
					'--heal',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			assert.ok(result.result.runDir, 'runDir must be present');

			// repairs/turn-1/runaway.json must exist (reasoning_runaway classification).
			const runawayPath = join(
				result.result.runDir,
				'repairs',
				'turn-1',
				'runaway.json',
			);
			let runawayJson;
			try {
				runawayJson = JSON.parse(await readFile(runawayPath, 'utf8'));
			} catch {
				runawayJson = null;
			}
			assert.ok(
				runawayJson !== null,
				'runaway.json must exist: reasoning_runaway was not classified (stale draft carryover still suppressing predicate)',
			);
			assert.equal(
				runawayJson.finishReason,
				'length',
				'runaway.json finishReason must be length',
			);

			// repairs.json stopReason must be 'reasoning_runaway'.
			const repairsPath = join(result.result.runDir, 'repairs', 'repairs.json');
			const repairsJson = JSON.parse(await readFile(repairsPath, 'utf8'));
			assert.equal(
				repairsJson.stopReason,
				'reasoning_runaway',
				`stopReason must be reasoning_runaway, got: ${repairsJson.stopReason}`,
			);
		} finally {
			await server.close();
		}
	});

	// (c) Legitimate heal write preserved — heal turn that DOES write_file a real fix
	// → that write is in writes.json and the file is applied. Proves clearing-before-
	// the-call does not eat the turn's own write.
	it('(c) legitimate heal write is preserved after draft cleared at turn-start', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p235-c-'));
		await writeNativeProfile(cwd, 'http://fake-placeholder.local/v1');

		const server = await startFakeModelServer({
			responses: [
				// Main run: write_file creates src/fix.mjs (broken syntax).
				makeWriteFileTurn({
					id: 'call_p235c_1',
					path: 'src/fix.mjs',
					content: 'export const broken = ;\n',
					chatId: 'chatcmpl_p235c_1',
				}),
				// Main run: stop.
				makeStopTurn('Wrote src/fix.mjs.', 'chatcmpl_p235c_2'),
				// Heal turn 1: DOES write_file with the fixed content (valid syntax).
				// clear() runs before this call; the turn's own write must survive.
				makeWriteFileTurn({
					id: 'call_p235c_heal',
					path: 'src/fix.mjs',
					content: 'export const broken = 1;\n',
					chatId: 'chatcmpl_p235c_heal_1',
				}),
				// Heal turn 1 second sub-turn: stop.
				makeStopTurn('Fixed src/fix.mjs.', 'chatcmpl_p235c_heal_2'),
			],
		});

		await writeNativeProfile(cwd, server.baseUrl);

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/fix.mjs',
					'--base-url',
					server.baseUrl,
					'--model',
					'test-model',
					'--out',
					'p235c-out',
					'--timeout-ms',
					'10000',
					'--tools',
					'--yes',
					'--test',
					'node --check src/fix.mjs',
					'--heal',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			assert.ok(result.result.runDir, 'runDir must be present');

			// The heal must have succeeded (file fixed).
			assert.equal(
				result.result.healed,
				true,
				`heal must succeed (healed=true), got: healed=${result.result.healed}, stopReason=${result.result.healStopReason}`,
			);
			// The fixed file must be on disk with valid content.
			const content = await readFile(join(cwd, 'src', 'fix.mjs'), 'utf8');
			assert.ok(
				content.includes('export const broken = 1;'),
				`file must have fixed content, got: ${content}`,
			);
		} finally {
			await server.close();
		}
	});

	// (d) Inter-turn carryover is the same mechanism as (a): repairTurn clears the
	// draft at the TOP of EVERY heal turn, so turn-2 clears turn-1's draft just as
	// turn-1 clears the main run's draft. Proven at the unit level by the
	// 'inter-turn carryover' test in healing.test.mjs's ProposalDraft.clear()
	// describe — no always-pass placeholder is kept here.
});

// ---------------------------------------------------------------------------
// Phase 240 — Staged Reasoning-Runaway Fast-Fail
// ---------------------------------------------------------------------------

describe('Phase 240 — staged reasoning-runaway fast-fail', () => {
	// Helper: build a staged-runaway response (finish_reason=length, empty content).
	// Provenance: phase-238-audit/rest-api-sqlite-2 conversation.json turn 11.
	function makeLengthTurn(chatId = 'chatcmpl_staged_len') {
		return {
			body: {
				choices: [
					{
						finish_reason: 'length',
						message: { content: '', role: 'assistant' },
					},
				],
				id: chatId,
				object: 'chat.completion',
				usage: {
					completion_tokens: 23000,
					prompt_tokens: 9709,
					total_tokens: 32709,
				},
			},
			method: 'POST',
			status: 200,
			url: '/v1/chat/completions',
		};
	}

	// Test A: stage 1 runaways (finish_reason=length + empty), retry returns a
	// valid proposal. Assert: stage record has runawayRetry:true, file is written.
	it('(A) runaway then retry-succeeds: stage record carries runawayRetry:true and file is written', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p240-a-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/answer.mjs","done"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: finish_reason=length, empty content — reasoning runaway.
				makeLengthTurn('chatcmpl_p240a_runaway'),
				// Stage 1 retry: returns a valid proposal with the file.
				{
					body: proposalResponse({
						files: [
							{
								content: 'export const answer = 42;\n',
								path: 'src/answer.mjs',
							},
						],
						messages: [{ content: 'STAGED_DONE', level: 'info' }],
						scratchpad: '{"done":["create src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p240a-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p240a-out', 'summary.json'), 'utf8'),
			);

			// Stage 1 record must carry runawayRetry:true.
			const stage1 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-1',
			);
			assert.ok(stage1, 'implement-1 stage record must exist');
			assert.equal(
				stage1.runawayRetry,
				true,
				`stage1 must have runawayRetry:true, got: ${JSON.stringify(stage1)}`,
			);
			assert.ok(
				stage1.runaway,
				`stage1 must have runaway evidence, got: ${JSON.stringify(stage1)}`,
			);
			assert.equal(
				stage1.runaway.finishReason,
				'length',
				`runaway.finishReason must be 'length'`,
			);
			// File must have been written.
			assert.ok(
				stage1.writeCount >= 1,
				`stage1.writeCount must be >= 1, got: ${stage1.writeCount}`,
			);
			// staged.runawayRetries must reflect the retry count.
			assert.equal(
				summary.staged?.runawayRetries,
				1,
				`staged.runawayRetries must be 1, got: ${summary.staged?.runawayRetries}`,
			);
		} finally {
			await server.close();
		}
	});

	// Test B: stage 1 runaways, retry also runaways.
	// Assert: writeError.name === 'ProposalMissingError', no infinite loop.
	it('(B) double-runaway: retry also runaways, falls through to ProposalMissingError', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p240-b-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: first runaway.
				makeLengthTurn('chatcmpl_p240b_run1'),
				// Stage 1 retry: also runaways (no infinite loop — only one retry).
				makeLengthTurn('chatcmpl_p240b_run2'),
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p240b-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p240b-out', 'summary.json'), 'utf8'),
			);

			// Run must have failed with ProposalMissingError.
			assert.equal(
				summary.writeError?.name,
				'ProposalMissingError',
				`writeError.name must be ProposalMissingError, got: ${summary.writeError?.name}`,
			);
			// Only exactly two model calls after the plan (the original runaway + one retry,
			// no further retries). Total = plan + runaway + retry = 3 calls.
			const completionCalls = server.recordings.filter(
				(r) => r.url === '/v1/chat/completions',
			);
			assert.equal(
				completionCalls.length,
				3,
				`must make exactly 3 model calls (plan + runaway + 1 retry), got: ${completionCalls.length}`,
			);
		} finally {
			await server.close();
		}
	});

	// Test C: stage 1 returns finish_reason=stop with empty content (not a runaway).
	// Assert: stage record has no runawayRetry field (the length gate is the distinction).
	// Note: the E4 empty-turn nudge fires for stop+empty (existing pipeline behavior),
	// so the total call count is plan + stage1-stop-empty + E4-nudge-response = 3.
	// The key invariant is that NO staged-retry fires (runawayRetry absent on stage record).
	it('(C) stop+empty is NOT a runaway: no runawayRetry on stage record (length gate is discriminator)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-p240-c-'));

		const server = await startFakeModelServer({
			responses: [
				// Plan turn.
				{
					body: proposalResponse({
						files: [],
						messages: [{ content: 'Plan ready.', level: 'info' }],
						scratchpad: '{"plan":["create src/answer.mjs"]}',
					}),
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// Stage 1: finish_reason=stop, empty content — NOT a runaway.
				// The length gate (isReasoningRunaway) must NOT fire for 'stop'.
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '', role: 'assistant' },
							},
						],
						id: 'chatcmpl_p240c_stop',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
				// E4 empty-turn nudge response: also stop+empty (let ProposalMissingError fire).
				{
					body: {
						choices: [
							{
								finish_reason: 'stop',
								message: { content: '', role: 'assistant' },
							},
						],
						id: 'chatcmpl_p240c_nudge',
						object: 'chat.completion',
					},
					method: 'POST',
					status: 200,
					url: '/v1/chat/completions',
				},
			],
		});

		try {
			const result = await main(
				[
					'run',
					'-p',
					'Create src/answer.mjs',
					'--staged',
					'--base-url',
					server.baseUrl,
					'--out',
					'p240c-out',
					'--timeout-ms',
					'10000',
					'--yes',
					'--json',
				],
				{
					cwd,
					env: {},
					stderr: { write: () => {} },
					stdout: { write: () => {} },
				},
			);

			const summary = JSON.parse(
				await readFile(join(cwd, 'p240c-out', 'summary.json'), 'utf8'),
			);

			// Should fail with ProposalMissingError (stop+empty is not a runaway).
			assert.equal(
				summary.writeError?.name,
				'ProposalMissingError',
				`writeError.name must be ProposalMissingError, got: ${summary.writeError?.name}`,
			);
			// Stage 1 record must NOT have runawayRetry (no staged-retry fired).
			const stage1 = summary.staged?.stages?.find(
				(s) => s.name === 'implement-1',
			);
			assert.ok(stage1, 'implement-1 stage record must exist');
			assert.equal(
				stage1.runawayRetry,
				undefined,
				`stage1 must NOT have runawayRetry for stop+empty, got: ${stage1.runawayRetry}`,
			);
			// staged.runawayRetries must be absent (no retries fired).
			assert.equal(
				summary.staged?.runawayRetries,
				undefined,
				`staged.runawayRetries must be absent, got: ${summary.staged?.runawayRetries}`,
			);
		} finally {
			await server.close();
		}
	});
});
