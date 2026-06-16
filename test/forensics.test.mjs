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

	it('surfaces extraction metadata (merged + repairs) in Proposal Extraction (phase 128)', async () => {
		const dir = await makeRunDir(tmp, 'run-extraction-meta', {
			'summary.json': {
				...SUMMARY_OK,
				extraction: {
					candidateCount: 3,
					proposalCount: 2,
					merged: true,
					repairs: [{ ruleId: 'gpt-oss-missing-brace', count: 1 }],
				},
			},
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const metaStep = story
			.filter((s) => s.phase === 'Proposal Extraction')
			.find((s) => s.detail && s.detail.includes('assembled from'));
		assert.ok(metaStep, 'should have an extraction metadata step');
		assert.match(metaStep.detail, /assembled from 2 blocks/u);
		assert.match(metaStep.detail, /gpt-oss-missing-brace×1/u);
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

	// D2: timeout detail in forensics Healing step
	it('D2: healing step detail includes elapsed and limit on timeout', async () => {
		const repairsObj = {
			finalVerification: { ok: false },
			healed: false,
			repairs: [
				{
					completionChars: 0,
					durationMs: 35000,
					elapsedMs: 35000,
					error: {
						name: 'HealingTimeoutError',
						message: 'timed out',
						elapsedMs: 35000,
						timeoutMs: 60000,
					},
					index: 1,
					ok: false,
					promptChars: 500,
					stopReason: 'timeout',
					timeoutMs: 60000,
					usage: null,
				},
			],
			stopReason: 'timeout',
			wrongPathWarnings: 0,
		};
		const dir = await makeRunDir(tmp, 'run-heal-timeout', {
			'summary.json': SUMMARY_OK,
			'repairs/repairs.json': repairsObj,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const healStep = story.find((s) => s.phase === 'Healing');
		assert.equal(healStep.status, 'fail');
		assert.match(healStep.detail, /timeout/u);
		assert.match(healStep.detail, /35s/u, 'should include elapsed seconds');
		assert.match(healStep.detail, /60s/u, 'should include limit seconds');
	});

	it('D2: healing step handles legacy array repairs.json format', async () => {
		// Older fixtures stored repairs.json as a plain array
		const repairs = [{ ok: true, stopReason: 'healed', turn: 1 }];
		const dir = await makeRunDir(tmp, 'run-heal-legacy', {
			'summary.json': SUMMARY_OK,
			'repairs/repairs.json': repairs,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const healStep = story.find((s) => s.phase === 'Healing');
		assert.equal(healStep.status, 'ok');
		assert.match(healStep.detail, /healingTurns=1/u);
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

	// F5 tests
	it('F5: relative path with separator resolves against cwd', async () => {
		const runDir = await makeRunDir(tmp, 'run-rel-sep', {
			'summary.json': SUMMARY_OK,
		});
		// Pass a path relative to tmp that contains '/'
		const rel = `run-rel-sep`;
		// The path includes tmp as cwd — so join is just the dir name but we
		// use a path with a '.' prefix to trigger the path-separator branch.
		const result = await resolveRunDir(tmp, `./${rel}`);
		assert.equal(result, runDir);
	});

	it('F5: path-like arg pointing to non-run directory throws clear error', async () => {
		const notARunDir = join(tmp, 'not-a-run-dir');
		await mkdir(notARunDir, { recursive: true });
		// Pass a relative path that exists but has no run artifacts
		await assert.rejects(
			() => resolveRunDir(tmp, './not-a-run-dir'),
			/not a kodr run directory/,
		);
	});

	it('F5: absolute path to non-run directory throws clear error', async () => {
		const notARunDir = join(tmp, 'not-a-run-dir-abs');
		await mkdir(notARunDir, { recursive: true });
		await assert.rejects(
			() => resolveRunDir(tmp, notARunDir),
			/not a kodr run directory/,
		);
	});

	it('F5: kodr-runs double-prefix scenario: relative kodr path throws instead of all-skip', async () => {
		// Simulates the failure: user types `.kodr/runs/<id>` which previously
		// double-prefixed to .kodr/runs/.kodr/runs/<id>
		const kodrRunsDir = join(tmp, '.kodr', 'runs', 'run-for-rel');
		await mkdir(kodrRunsDir, { recursive: true });
		await writeFile(
			join(kodrRunsDir, 'summary.json'),
			JSON.stringify(SUMMARY_OK),
		);
		// Pass the relative path as the user would — contains sep, so resolves vs cwd
		const result = await resolveRunDir(tmp, '.kodr/runs/run-for-rel');
		assert.equal(result, kodrRunsDir);
	});
});

// F4 tests
describe('buildCausalStory — F4 Model Call honest failure', () => {
	let tmp4;
	before(async () => {
		tmp4 = join(tmpdir(), `forensics-f4-${Date.now()}`);
		await mkdir(tmp4, { recursive: true });
	});
	after(async () => {
		await rm(tmp4, { recursive: true, force: true });
	});

	it('F4: Model Call is fail when summary.ok=false and responseCount=0', async () => {
		const dir = await makeRunDir(tmp4, 'run-budget-exhausted', {
			'summary.json': {
				...SUMMARY_OK,
				ok: false,
				responseCount: 0,
				loopBudget: {
					...SUMMARY_OK.loopBudget,
					stopReason: 'turn_budget_exhausted',
				},
			},
			'error.json': {
				message: 'Loop budget stopped: turn_budget_exhausted',
				name: 'LoopBudgetError',
				stack:
					'LoopBudgetError: Loop budget stopped: turn_budget_exhausted\n    at completeWithToolCalls',
			},
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const modelStep = story.find((s) => s.phase === 'Model Call');
		assert.equal(modelStep.status, 'fail', 'Model Call should be fail');
		assert.ok(
			modelStep.detail.includes('turn_budget_exhausted') ||
				modelStep.detail.includes('LoopBudgetError'),
			'detail should include the error',
		);
	});

	it('F4: Model Call is ok when run succeeded with responses', async () => {
		const dir = await makeRunDir(tmp4, 'run-ok', {
			'summary.json': SUMMARY_OK,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const modelStep = story.find((s) => s.phase === 'Model Call');
		assert.equal(modelStep.status, 'ok');
	});

	it('F4: loadRunAnalysis loads error.json', async () => {
		const errorObj = { message: 'some error', name: 'CliError' };
		const dir = await makeRunDir(tmp4, 'run-with-error-json', {
			'summary.json': SUMMARY_OK,
			'error.json': errorObj,
		});
		const analysis = await loadRunAnalysis(dir);
		assert.ok(analysis.errorJson !== null, 'errorJson should be loaded');
		assert.equal(analysis.errorJson.name, 'CliError');
	});
});

// ---------------------------------------------------------------------------
// C3 (phase 121) — syntaxCheck in summary.json surfaces in kodr why
// ---------------------------------------------------------------------------

describe('buildCausalStory — C3 syntaxCheck forensics', () => {
	let tmp3;
	before(async () => {
		tmp3 = join(tmpdir(), `forensics-c3-${Date.now()}`);
		await mkdir(tmp3, { recursive: true });
	});
	after(async () => {
		await rm(tmp3, { recursive: true, force: true });
	});

	it('C3: syntaxCheck pass surfaces "syntax check: N files ok" in Verification', async () => {
		const dir = await makeRunDir(tmp3, 'run-syntax-ok', {
			'summary.json': {
				...SUMMARY_OK,
				syntaxCheck: { ok: true, checked: 2, failures: [] },
			},
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const verificationSteps = story.filter((s) => s.phase === 'Verification');
		assert.ok(
			verificationSteps.length > 0,
			'should have at least one Verification step',
		);
		const syntaxStep = verificationSteps.find(
			(s) => s.detail && s.detail.includes('syntax check:'),
		);
		assert.ok(syntaxStep, 'should have a syntax check step');
		assert.equal(syntaxStep.status, 'ok');
		assert.match(syntaxStep.detail, /syntax check: 2 files ok/u);
	});

	it('C3: syntaxCheck fail surfaces "syntax check FAILED" in Verification with path and message', async () => {
		const dir = await makeRunDir(tmp3, 'run-syntax-fail', {
			'summary.json': {
				...SUMMARY_OK,
				ok: false,
				syntaxCheck: {
					ok: false,
					checked: 1,
					failures: [
						{ path: 'src/x.mjs', message: 'Illegal return statement' },
					],
				},
			},
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const syntaxStep = story
			.filter((s) => s.phase === 'Verification')
			.find((s) => s.detail && s.detail.includes('syntax check'));
		assert.ok(syntaxStep, 'should have a syntax check step');
		assert.equal(syntaxStep.status, 'fail');
		assert.match(syntaxStep.detail, /syntax check FAILED/u);
		assert.match(syntaxStep.detail, /src\/x\.mjs/u);
		assert.match(syntaxStep.detail, /Illegal return statement/u);
	});

	it('C3: syntaxCheck absent when summary has no syntaxCheck (non-JS run)', async () => {
		// SUMMARY_OK has no syntaxCheck field — Verification step should not mention syntax
		const dir = await makeRunDir(tmp3, 'run-no-syntax-check', {
			'summary.json': SUMMARY_OK,
			'tests.json': TESTS_PASS,
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const syntaxStep = story
			.filter((s) => s.phase === 'Verification')
			.find((s) => s.detail && s.detail.includes('syntax check'));
		assert.equal(
			syntaxStep,
			undefined,
			'no syntax check step when not in summary',
		);
	});

	it('C3: singular "file" label when checked===1', async () => {
		const dir = await makeRunDir(tmp3, 'run-syntax-ok-one', {
			'summary.json': {
				...SUMMARY_OK,
				syntaxCheck: { ok: true, checked: 1, failures: [] },
			},
		});
		const analysis = await loadRunAnalysis(dir);
		const story = buildCausalStory(analysis);
		const syntaxStep = story
			.filter((s) => s.phase === 'Verification')
			.find((s) => s.detail && s.detail.includes('syntax check'));
		assert.match(syntaxStep.detail, /syntax check: 1 file ok/u);
	});
});

// ---------------------------------------------------------------------------
// Phase 156 — smokeCheck in summary.json surfaces in kodr why
// ---------------------------------------------------------------------------

describe('buildCausalStory — phase 156 smokeCheck forensics', () => {
	let tmpSmoke;
	before(async () => {
		tmpSmoke = join(tmpdir(), `forensics-smoke-${Date.now()}`);
		await mkdir(tmpSmoke, { recursive: true });
	});
	after(async () => {
		await rm(tmpSmoke, { recursive: true, force: true });
	});

	const smokeStep = (story) =>
		story
			.filter((s) => s.phase === 'Verification')
			.find((s) => s.detail && s.detail.includes('smoke check'));

	it('ok status surfaces "smoke check: <entry> loaded ok"', async () => {
		const dir = await makeRunDir(tmpSmoke, 'run-smoke-ok', {
			'summary.json': {
				...SUMMARY_OK,
				smokeCheck: { ok: true, status: 'ok', entry: 'src/server.mjs' },
			},
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const step = smokeStep(story);
		assert.ok(step, 'should have a smoke check step');
		assert.equal(step.status, 'ok');
		assert.match(step.detail, /smoke check: src\/server\.mjs loaded ok/u);
	});

	it('failed status surfaces "smoke check FAILED" with entry and message', async () => {
		const dir = await makeRunDir(tmpSmoke, 'run-smoke-fail', {
			'summary.json': {
				...SUMMARY_OK,
				ok: false,
				smokeCheck: {
					ok: false,
					status: 'failed',
					entry: 'src/auth.mjs',
					message: "SyntaxError: does not provide an export named 'sign'",
				},
			},
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const step = smokeStep(story);
		assert.ok(step, 'should have a smoke check step');
		assert.equal(step.status, 'fail');
		assert.match(step.detail, /smoke check FAILED/u);
		assert.match(step.detail, /src\/auth\.mjs/u);
		assert.match(step.detail, /export named 'sign'/u);
	});

	it('skipped status (deps not installed) is advisory (warn)', async () => {
		const dir = await makeRunDir(tmpSmoke, 'run-smoke-skip', {
			'summary.json': {
				...SUMMARY_OK,
				smokeCheck: {
					ok: false,
					status: 'skipped',
					entry: 'index.mjs',
					message: 'dependencies not installed (...) — smoke-check skipped',
				},
			},
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const step = smokeStep(story);
		assert.ok(step, 'should have a smoke check step');
		assert.equal(step.status, 'warn');
		assert.match(step.detail, /smoke check skipped/u);
	});

	it('absent when summary has no smokeCheck', async () => {
		const dir = await makeRunDir(tmpSmoke, 'run-no-smoke', {
			'summary.json': SUMMARY_OK,
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		assert.equal(smokeStep(story), undefined);
	});
});

// ---------------------------------------------------------------------------
// C4 (phase 122) — languageGuidance source surfaces in Context Assembly
// ---------------------------------------------------------------------------

describe('buildCausalStory — C4 language guidance forensics', () => {
	let tmp4;
	before(async () => {
		tmp4 = join(tmpdir(), `forensics-c4-${Date.now()}`);
		await mkdir(tmp4, { recursive: true });
	});
	after(async () => {
		await rm(tmp4, { recursive: true, force: true });
	});

	it('C4: builtin source surfaces "node guidance: builtin"', async () => {
		const dir = await makeRunDir(tmp4, 'run-lang-builtin', {
			'summary.json': {
				...SUMMARY_OK,
				languageGuidance: { language: 'node', source: 'builtin' },
			},
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const step = story
			.filter((s) => s.phase === 'Context Assembly')
			.find((s) => s.detail && s.detail.includes('guidance'));
		assert.ok(step, 'should have a language guidance step');
		assert.equal(step.status, 'ok');
		assert.match(step.detail, /node guidance: builtin/u);
	});

	it('C4: override source surfaces "node guidance: override"', async () => {
		const dir = await makeRunDir(tmp4, 'run-lang-override', {
			'summary.json': {
				...SUMMARY_OK,
				languageGuidance: { language: 'node', source: 'override' },
			},
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const step = story
			.filter((s) => s.phase === 'Context Assembly')
			.find((s) => s.detail && s.detail.includes('guidance'));
		assert.match(step.detail, /node guidance: override/u);
	});

	it('C4: absent when summary has no languageGuidance', async () => {
		const dir = await makeRunDir(tmp4, 'run-lang-none', {
			'summary.json': SUMMARY_OK,
		});
		const story = buildCausalStory(await loadRunAnalysis(dir));
		const step = story
			.filter((s) => s.phase === 'Context Assembly')
			.find((s) => s.detail && s.detail.includes('guidance'));
		assert.equal(step, undefined);
	});
});
