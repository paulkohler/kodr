import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import {
	buildCausalStory,
	loadRunAnalysis,
	renderForensicsCli,
	renderForensicsHtml,
	resolveRunDir,
} from '../src/forensics.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeRunDir(base, name, artifacts = {}) {
	const dir = join(base, name);
	await mkdir(dir, { recursive: true });
	for (const [filename, content] of Object.entries(artifacts)) {
		const parts = filename.split('/');
		if (parts.length > 1) {
			await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
		}
		await writeFile(
			join(dir, filename),
			typeof content === 'string' ? content : JSON.stringify(content),
		);
	}
	return dir;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SUMMARY_OK = {
	artifacts: {
		context: 'context.md',
		prompt: 'prompt.md',
		response: 'response.md',
		summary: 'summary.json',
		tests: 'tests.json',
		writes: 'writes.json',
	},
	baseUrl: 'http://localhost:1234/v1',
	finishReasons: ['stop'],
	loopBudget: {
		costUsd: 0,
		maxCostUsd: null,
		maxRetries: 7,
		maxTokens: null,
		maxTurns: 8,
		retries: 0,
		stopReason: 'finish_stop',
		tokens: 22053,
		turns: 1,
	},
	model: 'qwen/qwen3.6-35b-a3b',
	ok: true,
	promptChars: 42,
	promptId: 'abc123',
	proposalFound: true,
	proposalMessageCount: 0,
	proposalStatus: 'OK',
	responseChars: 207,
	responseCount: 1,
	tested: false,
	timestamp: '2026-06-11T10:00:00.000Z',
	workspaceFileCount: 53,
	writeCount: 0,
};

const WRITES_DRY = { applied: false, writes: [] };
const WRITES_APPLIED = {
	applied: true,
	writes: [{ op: 'write', path: 'src/foo.mjs' }],
};

const TESTS_PASS = { command: 'node --test', ok: true, output: 'pass: 5' };
const TESTS_FAIL = { command: 'node --test', ok: false, output: 'fail: 1' };

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let tmp;

before(async () => {
	tmp = join(tmpdir(), `forensics-test-${Date.now()}`);
	await mkdir(tmp, { recursive: true });
});

after(async () => {
	await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadRunAnalysis
// ---------------------------------------------------------------------------

describe('loadRunAnalysis', () => {
	it('reads summary.json and returns structured data', async () => {
		const dir = await makeRunDir(tmp, 'run-summary', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		assert.ok(analysis.summary, 'summary should be present');
		assert.equal(analysis.summary.model, 'qwen/qwen3.6-35b-a3b');
		assert.equal(analysis.runDir, dir);
	});

	it('returns null for missing artifacts without throwing', async () => {
		const dir = await makeRunDir(tmp, 'run-empty', {});
		const analysis = await loadRunAnalysis(dir);
		assert.equal(analysis.summary, null);
		assert.equal(analysis.writes, null);
		assert.equal(analysis.tests, null);
		assert.equal(analysis.contextMd, null);
		assert.equal(analysis.promptMd, null);
		assert.equal(analysis.responseMd, null);
		assert.equal(analysis.repairs, null);
	});

	it('reads writes.json and tests.json', async () => {
		const dir = await makeRunDir(tmp, 'run-with-writes', {
			'summary.json': SUMMARY_OK,
			'writes.json': WRITES_APPLIED,
			'tests.json': TESTS_PASS,
		});
		const analysis = await loadRunAnalysis(dir);
		assert.equal(analysis.writes.applied, true);
		assert.equal(analysis.writes.writes.length, 1);
		assert.equal(analysis.tests.ok, true);
	});

	it('reads context.md as text', async () => {
		const dir = await makeRunDir(tmp, 'run-context', {
			'context.md': '## Strategy: whole-file\n\nsome context here',
		});
		const analysis = await loadRunAnalysis(dir);
		assert.ok(analysis.contextMd.includes('whole-file'));
	});

	it('reads repairs/repairs.json', async () => {
		const repairs = [{ ok: true, stopReason: 'healed', turn: 1 }];
		const dir = await makeRunDir(tmp, 'run-repairs', {
			'repairs/repairs.json': repairs,
		});
		const analysis = await loadRunAnalysis(dir);
		assert.equal(Array.isArray(analysis.repairs), true);
		assert.equal(analysis.repairs[0].stopReason, 'healed');
	});
});

// ---------------------------------------------------------------------------
// buildCausalStory
// ---------------------------------------------------------------------------

describe('buildCausalStory', () => {
	it('produces 7 steps for a fully-populated run', async () => {
		const dir = await makeRunDir(tmp, 'run-full', {
			'context.md': '## whole-file context',
			'summary.json': SUMMARY_OK,
			'writes.json': WRITES_DRY,
			'tests.json': null,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		assert.equal(story.length, 7);
	});

	it('step phases appear in canonical order', async () => {
		const dir = await makeRunDir(tmp, 'run-phases', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const phases = story.map((s) => s.phase);
		assert.deepEqual(phases, [
			'Context Assembly',
			'Model Call',
			'Proposal Extraction',
			'Edit Application',
			'Verification',
			'Healing',
			'Final Outcome',
		]);
	});

	it('marks proposal extraction fail when proposalFound=false', async () => {
		const dir = await makeRunDir(tmp, 'run-no-proposal', {
			'summary.json': {
				...SUMMARY_OK,
				proposalFound: false,
				proposalStatus: '',
			},
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const propStep = story.find((s) => s.phase === 'Proposal Extraction');
		assert.equal(propStep.status, 'fail');
	});

	it('marks final outcome fail when ok=false', async () => {
		const dir = await makeRunDir(tmp, 'run-failed', {
			'summary.json': { ...SUMMARY_OK, ok: false },
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const outcome = story.find((s) => s.phase === 'Final Outcome');
		assert.equal(outcome.status, 'fail');
	});

	it('marks verification fail when tests.ok=false', async () => {
		const dir = await makeRunDir(tmp, 'run-tests-fail', {
			'summary.json': SUMMARY_OK,
			'tests.json': TESTS_FAIL,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const testStep = story.find((s) => s.phase === 'Verification');
		assert.equal(testStep.status, 'fail');
	});

	it('marks verification ok when tests.ok=true', async () => {
		const dir = await makeRunDir(tmp, 'run-tests-pass', {
			'summary.json': SUMMARY_OK,
			'tests.json': TESTS_PASS,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const testStep = story.find((s) => s.phase === 'Verification');
		assert.equal(testStep.status, 'ok');
	});

	it('marks edit application ok when writes applied', async () => {
		const dir = await makeRunDir(tmp, 'run-applied', {
			'summary.json': SUMMARY_OK,
			'writes.json': WRITES_APPLIED,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const editStep = story.find((s) => s.phase === 'Edit Application');
		assert.equal(editStep.status, 'ok');
	});

	it('marks healing ok when stopReason=healed', async () => {
		const repairs = [{ ok: true, stopReason: 'healed', turn: 1 }];
		const dir = await makeRunDir(tmp, 'run-healed', {
			'summary.json': SUMMARY_OK,
			'repairs/repairs.json': repairs,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const healStep = story.find((s) => s.phase === 'Healing');
		assert.equal(healStep.status, 'ok');
		assert.ok(healStep.detail.includes('healingTurns=1'));
	});

	it('skips context assembly when context.md absent', async () => {
		const dir = await makeRunDir(tmp, 'run-no-ctx', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const ctxStep = story.find((s) => s.phase === 'Context Assembly');
		assert.equal(ctxStep.status, 'skip');
	});

	it('each step has phase, status, and detail fields', async () => {
		const dir = await makeRunDir(tmp, 'run-shape', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		for (const step of story) {
			assert.ok(typeof step.phase === 'string', 'phase must be a string');
			assert.ok(
				['ok', 'fail', 'warn', 'skip'].includes(step.status),
				`invalid status: ${step.status}`,
			);
			assert.ok(typeof step.detail === 'string', 'detail must be a string');
		}
	});
});

// ---------------------------------------------------------------------------
// renderForensicsCli
// ---------------------------------------------------------------------------

describe('renderForensicsCli', () => {
	it('output contains all phase labels', async () => {
		const dir = await makeRunDir(tmp, 'render-cli', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const out = renderForensicsCli(analysis, story);
		assert.ok(out.includes('Context Assembly'));
		assert.ok(out.includes('Model Call'));
		assert.ok(out.includes('Proposal Extraction'));
		assert.ok(out.includes('Edit Application'));
		assert.ok(out.includes('Verification'));
		assert.ok(out.includes('Healing'));
		assert.ok(out.includes('Final Outcome'));
	});

	it('output includes run directory path', async () => {
		const dir = await makeRunDir(tmp, 'render-cli-dir', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const out = renderForensicsCli(analysis, story);
		assert.ok(out.includes(dir));
	});

	it('output contains run id (basename)', async () => {
		const dir = await makeRunDir(tmp, 'my-run-2026', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const out = renderForensicsCli(analysis, story);
		assert.ok(out.includes('my-run-2026'));
	});
});

// ---------------------------------------------------------------------------
// renderForensicsHtml
// ---------------------------------------------------------------------------

describe('renderForensicsHtml', () => {
	it('returns a string starting with <!DOCTYPE html>', async () => {
		const dir = await makeRunDir(tmp, 'render-html', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const html = renderForensicsHtml(analysis, story);
		assert.ok(typeof html === 'string');
		assert.ok(html.startsWith('<!DOCTYPE html>'));
	});

	it('contains all phase labels', async () => {
		const dir = await makeRunDir(tmp, 'render-html-phases', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const html = renderForensicsHtml(analysis, story);
		for (const phase of [
			'Context Assembly',
			'Model Call',
			'Proposal Extraction',
			'Edit Application',
			'Verification',
			'Healing',
			'Final Outcome',
		]) {
			assert.ok(html.includes(phase), `HTML missing phase: ${phase}`);
		}
	});

	it('contains model name from summary', async () => {
		const dir = await makeRunDir(tmp, 'render-html-model', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const html = renderForensicsHtml(analysis, story);
		assert.ok(html.includes('qwen/qwen3.6-35b-a3b'));
	});

	it('does not contain script tags from untrusted content (escaping)', async () => {
		const dir = await makeRunDir(tmp, 'render-html-xss', {
			'summary.json': {
				...SUMMARY_OK,
				model: '<script>alert(1)</script>',
			},
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const html = renderForensicsHtml(analysis, story);
		assert.ok(!html.includes('<script>alert(1)</script>'));
		assert.ok(html.includes('&lt;script&gt;'));
	});

	it('has closing </html> tag', async () => {
		const dir = await makeRunDir(tmp, 'render-html-close', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const html = renderForensicsHtml(analysis, story);
		assert.ok(html.trimEnd().endsWith('</html>'));
	});
});

// ---------------------------------------------------------------------------
// resolveRunDir
// ---------------------------------------------------------------------------

describe('resolveRunDir', () => {
	it('returns absolute path when given an absolute path', async () => {
		const dir = await makeRunDir(tmp, 'run-abs', {
			'summary.json': SUMMARY_OK,
		});
		const result = await resolveRunDir(tmp, dir);
		assert.equal(result, dir);
	});

	it('resolves bare name under .kodr/runs/', async () => {
		const kodrDir = join(tmp, '.kodr', 'runs');
		await mkdir(kodrDir, { recursive: true });
		const result = await resolveRunDir(tmp, 'some-run-id');
		assert.equal(result, join(tmp, '.kodr', 'runs', 'some-run-id'));
	});

	it('reads .kodr/last-run when no arg given', async () => {
		const runDir = await makeRunDir(tmp, 'last-run-target', {
			'summary.json': SUMMARY_OK,
		});
		const kodrDir = join(tmp, 'cwd-last');
		await mkdir(join(kodrDir, '.kodr'), { recursive: true });
		await writeFile(join(kodrDir, '.kodr', 'last-run'), `${runDir}\n`);
		const result = await resolveRunDir(kodrDir, '');
		assert.equal(result, runDir);
	});

	it('reads .kodr/last-run when arg is "last"', async () => {
		const runDir = await makeRunDir(tmp, 'last-run-target-2', {
			'summary.json': SUMMARY_OK,
		});
		const kodrDir = join(tmp, 'cwd-last2');
		await mkdir(join(kodrDir, '.kodr'), { recursive: true });
		await writeFile(join(kodrDir, '.kodr', 'last-run'), `${runDir}\n`);
		const result = await resolveRunDir(kodrDir, 'last');
		assert.equal(result, runDir);
	});

	it('throws when no arg and last-run file missing', async () => {
		const noKodr = join(tmp, 'cwd-no-kodr');
		await mkdir(noKodr, { recursive: true });
		await assert.rejects(() => resolveRunDir(noKodr, ''), /last-run not found/);
	});
});
