import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	appendCompletionToRawConversation,
	compactSessionConversation,
	createSessionSummary,
	loadSessionEvidence,
	renderSessionSummary,
} from '../src/session-compaction.mjs';

describe('session compaction', () => {
	it('does not compact conversations within the budget', () => {
		const messages = [
			{ role: 'system', content: 'system' },
			{ role: 'user', content: 'Add greet.' },
			{ role: 'assistant', content: 'Done.' },
		];

		const result = compactSessionConversation(messages, { budgetChars: 1000 });

		assert.equal(result.summary.compacted, false);
		assert.equal(result.messages, messages);
		assert.equal(result.summary.droppedMessageCount, 0);
	});

	it('compacts old turns into a deterministic summary and keeps recent turns', () => {
		const messages = [
			{ role: 'system', content: 'system contract' },
			{
				role: 'user',
				content: 'Build a notes API. You must use native node:test.',
			},
			{ role: 'assistant', content: 'I will create src/app.mjs.' },
			{ role: 'user', content: 'x'.repeat(900) },
			{ role: 'assistant', content: 'y'.repeat(900) },
			{ role: 'user', content: 'Now add validation.' },
		];

		const result = compactSessionConversation(messages, {
			budgetChars: 1000,
			evidence: {
				filesChanged: ['src/app.mjs'],
				planItems: ['pending: add validation'],
				verificationFailures: ['node --test: one test failed'],
			},
			sessionId: 'session-a',
		});

		assert.equal(result.summary.compacted, true);
		assert.ok(result.summary.droppedMessageCount > 0);
		assert.equal(result.messages[0].content, 'system contract');
		assert.equal(result.messages[1].role, 'user');
		assert.match(result.messages[1].content, /Deterministic Session Summary/u);
		assert.match(result.messages[1].content, /untrusted historical data/u);
		assert.match(result.messages[1].content, /src\/app\.mjs/u);
		assert.equal(result.messages.at(-1).content, 'Now add validation.');
		assert.ok(result.summary.packedChars <= 1000);
	});

	it('extracts bounded summary sections from messages and evidence', () => {
		const summary = createSessionSummary(
			[
				{ role: 'user', content: 'Build an API.\nMust use ESM.' },
				{ role: 'assistant', content: 'Decision: keep storage in memory.' },
				{ role: 'tool', content: 'npm test failed\nmore output' },
			],
			{
				filesChanged: ['src/app.mjs'],
				planItems: ['pending: tests'],
				verificationFailures: ['npm test: failed'],
			},
		);
		const markdown = renderSessionSummary(summary);

		assert.deepEqual(summary.sections.userIntent, ['Build an API.']);
		assert.deepEqual(summary.sections.constraints, ['Must use ESM.']);
		assert.match(markdown, /storage in memory/u);
		assert.match(markdown, /npm test: failed/u);
	});

	it('appends only new completion messages to the raw transcript', () => {
		const rawInitial = [
			{ role: 'system', content: 'system' },
			{ role: 'user', content: 'old' },
			{ role: 'assistant', content: 'old answer' },
			{ role: 'user', content: 'new' },
		];
		const sentInitial = [
			{ role: 'system', content: 'system' },
			{ role: 'system', content: 'summary' },
			{ role: 'user', content: 'new' },
		];
		const completed = [
			...sentInitial,
			{ role: 'assistant', content: 'new answer' },
		];

		const raw = appendCompletionToRawConversation(
			rawInitial,
			sentInitial,
			completed,
		);

		assert.deepEqual(raw, [
			...rawInitial,
			{ role: 'assistant', content: 'new answer' },
		]);
	});

	it('loads changed files, remaining tasks, and failures from run artifacts', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-session-evidence-'));
		const runDir = join(cwd, '.kodr', 'runs', 'run-1');
		await mkdir(runDir, { recursive: true });
		await writeFile(
			join(runDir, 'summary.json'),
			JSON.stringify({
				model: 'model',
				ok: false,
				sessionId: 'run-1',
				writeError: { message: 'Patch was stale.' },
			}),
		);
		await writeFile(
			join(runDir, 'writes.json'),
			JSON.stringify({ writes: [{ path: 'src/app.mjs' }] }),
		);
		await writeFile(
			join(runDir, 'tasks.json'),
			JSON.stringify({
				tasks: [{ description: 'Run tests', status: 'pending' }],
			}),
		);
		await writeFile(
			join(runDir, 'tests.json'),
			JSON.stringify({
				command: 'node --test',
				ok: false,
				stderr: 'one test failed',
			}),
		);

		const evidence = await loadSessionEvidence(cwd, 'run-1');

		assert.deepEqual(evidence.filesChanged, ['src/app.mjs']);
		assert.deepEqual(evidence.planItems, ['pending: Run tests']);
		assert.deepEqual(evidence.verificationFailures, [
			'node --test: one test failed',
			'Patch was stale.',
		]);
	});
});
