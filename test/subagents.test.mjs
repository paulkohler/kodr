import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createCycleReviewRequest, runSubagent } from '../src/subagents.mjs';

describe('subagents', () => {
	it('writes request and result artifacts for cycle review', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-subagent-'));
		const runDir = join(cwd, '.koder', 'runs', 'review');
		await writeFile(
			join(cwd, 'AGENTS.md'),
			'- Run tests before committing.\n',
			'utf8',
		);

		const review = await runSubagent(
			cwd,
			runDir,
			createCycleReviewRequest({
				transcript:
					'User: Make sure examples are Kodr samples before moving on.\n',
				transcriptPath: 'chat.md',
			}),
		);

		assert.equal(review.result.ok, true);
		assert.equal(review.result.findings.length, 1);
		assert.match(review.result.findings[0].suggestedAgentNote, /Kodr samples/u);
		assert.match(
			await readFile(
				join(runDir, 'subagents', 'cycle-review', 'request.json'),
				'utf8',
			),
			/cycle-review/u,
		);
		assert.match(
			await readFile(
				join(runDir, 'subagents', 'cycle-review', 'result.json'),
				'utf8',
			),
			/Kodr samples/u,
		);
	});

	it('does not flag directions already represented in AGENTS.md', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-subagent-covered-'));
		const runDir = join(cwd, '.koder', 'runs', 'review');
		await writeFile(
			join(cwd, 'AGENTS.md'),
			'- Examples are Kodr samples and failed generations need recorded retries.\n',
			'utf8',
		);

		const review = await runSubagent(
			cwd,
			runDir,
			createCycleReviewRequest({
				transcript:
					'User: Make sure examples are Kodr samples before moving on.\n',
				transcriptPath: 'chat.md',
			}),
		);

		assert.equal(review.result.findings.length, 0);
	});
});
