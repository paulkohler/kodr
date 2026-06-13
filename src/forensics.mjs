// forensics.mjs — zero-dependency, ESM
// Reads run artifacts and builds a causal story for `kodr why`.

import { readFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

// ---------------------------------------------------------------------------
// Artifact loading
// ---------------------------------------------------------------------------

async function tryReadJson(filePath) {
	try {
		const text = await readFile(filePath, 'utf8');
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function tryReadText(filePath) {
	try {
		return await readFile(filePath, 'utf8');
	} catch {
		return null;
	}
}

/**
 * Load all relevant artifacts from a run directory.
 * Returns a structured analysis object; missing artifacts are null.
 *
 * @param {string} runDir  Absolute path to the run directory.
 * @returns {Promise<RunAnalysis>}
 */
export async function loadRunAnalysis(runDir) {
	const [summary, writes, tests, contextMd, promptMd, responseMd, errorJson] =
		await Promise.all([
			tryReadJson(join(runDir, 'summary.json')),
			tryReadJson(join(runDir, 'writes.json')),
			tryReadJson(join(runDir, 'tests.json')),
			tryReadText(join(runDir, 'context.md')),
			tryReadText(join(runDir, 'prompt.md')),
			tryReadText(join(runDir, 'response.md')),
			tryReadJson(join(runDir, 'error.json')),
		]);

	// Healing artifacts live in a repairs/ sub-directory written by healing.mjs.
	const repairs = await tryReadJson(join(runDir, 'repairs', 'repairs.json'));

	return {
		contextMd,
		errorJson,
		promptMd,
		repairs,
		responseMd,
		runDir,
		summary,
		tests,
		writes,
	};
}

// ---------------------------------------------------------------------------
// Causal story builder
// ---------------------------------------------------------------------------

/**
 * @typedef {{ phase: string, status: 'ok'|'fail'|'skip'|'warn', detail: string, artifactPath?: string }} StoryStep
 */

/**
 * Build a causal story from the run analysis.
 * Pure function — no I/O.
 *
 * @param {object} analysis  Result of loadRunAnalysis.
 * @returns {StoryStep[]}
 */
export function buildCausalStory(analysis) {
	const { summary, writes, tests, repairs, runDir, errorJson } = analysis;
	const steps = [];

	// ------------------------------------------------------------------
	// 1. Context Assembly
	// ------------------------------------------------------------------
	if (analysis.contextMd !== null) {
		const lines = (analysis.contextMd || '').split('\n');
		const fileCount = summary?.workspaceFileCount ?? '?';
		const strategy = summary?.contextStrategy ?? inferStrategy(lines);
		const chars = (analysis.contextMd || '').length;
		steps.push({
			artifactPath: join(runDir, 'context.md'),
			detail: `strategy=${strategy} workspaceFiles=${fileCount} contextChars=${chars}`,
			phase: 'Context Assembly',
			status: 'ok',
		});
	} else {
		steps.push({
			detail: 'context.md not found — run may not have recorded context',
			phase: 'Context Assembly',
			status: 'skip',
		});
	}

	// ------------------------------------------------------------------
	// 2. Model Call
	// ------------------------------------------------------------------
	if (summary) {
		const lb = summary.loopBudget || {};
		const finishReasons = (summary.finishReasons || []).join(', ') || '?';
		const tokens = lb.tokens ?? '?';
		const turns = lb.turns ?? '?';
		const model = summary.model || '?';
		const baseUrl = summary.baseUrl || '?';

		// F4: classify the Model Call step as fail when the run failed at the
		// model-loop level — either no responses were recorded, or error.json
		// holds a LoopBudgetError / completeWithToolCalls error.
		const isModelLoopError =
			errorJson !== null &&
			errorJson !== undefined &&
			(errorJson.name === 'LoopBudgetError' ||
				(typeof errorJson.stack === 'string' &&
					(errorJson.stack.includes('completeWithToolCalls') ||
						errorJson.stack.includes('completeWithContinuations'))));
		const noResponses =
			summary.ok === false && (summary.responseCount ?? 0) === 0;
		const modelCallFailed = isModelLoopError || noResponses;

		const transport = summary.transport || null;
		const ttftParts = [];
		if (transport) {
			const ttfts = transport.timeToFirstTokenMs;
			if (Array.isArray(ttfts) && ttfts.length > 0) {
				const avg = Math.round(ttfts.reduce((s, v) => s + v, 0) / ttfts.length);
				ttftParts.push(`first token after ${(avg / 1000).toFixed(1)}s`);
			}
			if (transport.firstTokenRetries > 0) {
				ttftParts.push(
					`${transport.firstTokenRetries} stall retr${transport.firstTokenRetries === 1 ? 'y' : 'ies'}`,
				);
			}
		}
		const transportSuffix =
			ttftParts.length > 0 ? ` (${ttftParts.join('; ')})` : '';

		steps.push({
			artifactPath: join(runDir, 'summary.json'),
			detail: modelCallFailed
				? `model=${model} baseUrl=${baseUrl} turns=${turns} tokens=${tokens} error=${errorJson?.message || 'no responses recorded'}`
				: `model=${model} baseUrl=${baseUrl} turns=${turns} tokens=${tokens} finishReasons=[${finishReasons}]${transportSuffix}`,
			phase: 'Model Call',
			status: modelCallFailed ? 'fail' : 'ok',
		});
	} else {
		steps.push({
			detail: 'summary.json not found',
			phase: 'Model Call',
			status: 'skip',
		});
	}

	// ------------------------------------------------------------------
	// 3. Proposal Extraction
	// ------------------------------------------------------------------
	if (summary) {
		const found = summary.proposalFound ?? false;
		const status = summary.proposalStatus || '';
		const msgCount = summary.proposalMessageCount ?? 0;
		// W5: surface proposalChannels when present.
		const channels = summary.proposalChannels;
		const channelSuffix = channels
			? ` (${channels.captured ?? 0} via write tools, ${channels.envelope ?? 0} via envelope${Object.keys(channels.aliasHits ?? {}).length > 0 ? `, aliases: ${JSON.stringify(channels.aliasHits)}` : ''})`
			: '';
		// D5 (phase 119): native-mode legibility — surface toolWritesMode + recoveredVia.
		const toolWritesMode = summary.toolWritesMode;
		const recoveredVia = summary.recoveredVia;
		const nativeSuffix =
			toolWritesMode === 'native'
				? recoveredVia && recoveredVia !== 'none'
					? ` [native mode: recovered via ${recoveredVia}]`
					: ` [native mode: ${channels?.captured ?? 0} file${(channels?.captured ?? 0) !== 1 ? 's' : ''} via write tools, no fallback needed]`
				: '';
		if (!found) {
			steps.push({
				artifactPath: join(runDir, 'response.md'),
				detail: `no proposal found in model response (responseChars=${summary.responseChars ?? '?'})${channelSuffix}${nativeSuffix}`,
				phase: 'Proposal Extraction',
				status: 'fail',
			});
		} else if (status !== 'OK') {
			steps.push({
				artifactPath: join(runDir, 'response.md'),
				detail: `proposal found but status=${status} messages=${msgCount}${channelSuffix}${nativeSuffix}`,
				phase: 'Proposal Extraction',
				status: 'warn',
			});
		} else {
			steps.push({
				artifactPath: join(runDir, 'response.md'),
				detail: `proposal found status=${status} messages=${msgCount}${channelSuffix}${nativeSuffix}`,
				phase: 'Proposal Extraction',
				status: 'ok',
			});
		}
	} else {
		steps.push({
			detail: 'no summary — cannot determine proposal status',
			phase: 'Proposal Extraction',
			status: 'skip',
		});
	}

	// ------------------------------------------------------------------
	// 4. Edit Application
	// ------------------------------------------------------------------
	if (writes !== null) {
		const applied = writes.applied === true;
		const list = Array.isArray(writes.writes) ? writes.writes : [];
		const count = list.length;
		// L4: surface applyMode for forensics legibility.
		const applyMode = summary?.applyMode || 'proposal';
		const applyModeSuffix =
			applyMode === 'live'
				? ' [apply mode: live — writes applied during the run]'
				: ' [apply mode: proposal — applied at completion]';
		if (!applied && count === 0) {
			steps.push({
				artifactPath: join(runDir, 'writes.json'),
				detail: `dry-run — no writes applied${applyModeSuffix}`,
				phase: 'Edit Application',
				status: 'skip',
			});
		} else if (applied) {
			steps.push({
				artifactPath: join(runDir, 'writes.json'),
				detail: `applied ${count} write(s)${applyModeSuffix}`,
				phase: 'Edit Application',
				status: 'ok',
			});
		} else {
			steps.push({
				artifactPath: join(runDir, 'writes.json'),
				detail: `${count} write(s) proposed, not applied (dry-run)${applyModeSuffix}`,
				phase: 'Edit Application',
				status: 'warn',
			});
		}
	} else {
		steps.push({
			detail: 'writes.json not found',
			phase: 'Edit Application',
			status: 'skip',
		});
	}

	// ------------------------------------------------------------------
	// 5. Verification
	// ------------------------------------------------------------------
	if (tests !== null && tests !== undefined) {
		if (typeof tests === 'object' && tests !== null && 'ok' in tests) {
			const ok = tests.ok === true;
			const cmd = tests.command || '';
			const out = tests.output ? tests.output.slice(0, 120) : '';
			steps.push({
				artifactPath: join(runDir, 'tests.json'),
				detail: `command=${cmd || '(none)'} passed=${ok}${out ? ` output=${JSON.stringify(out)}` : ''}`,
				phase: 'Verification',
				status: ok ? 'ok' : 'fail',
			});
		} else {
			// tests.json exists but is null or has no .ok field
			steps.push({
				artifactPath: join(runDir, 'tests.json'),
				detail: 'no test run recorded',
				phase: 'Verification',
				status: 'skip',
			});
		}
	} else {
		steps.push({
			detail: 'tests.json not found — verification not configured',
			phase: 'Verification',
			status: 'skip',
		});
	}

	// ------------------------------------------------------------------
	// 6. Healing
	// ------------------------------------------------------------------
	if (repairs !== null && repairs !== undefined) {
		// repairs.json is the full result object; the repairs array is nested.
		// Accept both for backwards compatibility with older fixtures.
		const repairsObj = Array.isArray(repairs) ? null : repairs;
		const list = Array.isArray(repairs)
			? repairs
			: Array.isArray(repairs?.repairs)
				? repairs.repairs
				: [];
		const overallStop = repairsObj?.stopReason || list.at(-1)?.stopReason || '';
		const turns = list.length;
		const ok = overallStop === 'healed' || list.at(-1)?.ok === true;

		// D2: for timeout, include elapsed and limit in the detail line
		let detail = `healingTurns=${turns} stopReason=${overallStop || '(none)'}`;
		if (overallStop === 'timeout') {
			const timedOut = list.find((r) => r.stopReason === 'timeout');
			const elapsed = timedOut?.elapsedMs ?? timedOut?.durationMs;
			const limit = timedOut?.timeoutMs;
			const turnIdx = timedOut?.index ?? turns;
			const elapsedSec =
				elapsed != null ? `${Math.round(elapsed / 1000)}s` : '?';
			const limitSec = limit != null ? `${Math.round(limit / 1000)}s` : '?';
			detail = `healingTurns=${turns} stopReason=timeout repair turn ${turnIdx} timed out after ${elapsedSec} (limit ${limitSec})`;
		}

		steps.push({
			artifactPath: join(runDir, 'repairs', 'repairs.json'),
			detail,
			phase: 'Healing',
			status: turns === 0 ? 'skip' : ok ? 'ok' : 'fail',
		});
	} else {
		steps.push({
			detail: 'no healing run',
			phase: 'Healing',
			status: 'skip',
		});
	}

	// ------------------------------------------------------------------
	// 7. Final Outcome
	// ------------------------------------------------------------------
	if (summary) {
		const lb = summary.loopBudget || {};
		const ok = summary.ok === true;
		const stopReason = lb.stopReason || '?';
		const manifestKeys = Object.keys(summary.artifacts || {}).join(', ');
		steps.push({
			artifactPath: join(runDir, 'summary.json'),
			detail: `ok=${ok} stopReason=${stopReason} artifacts=[${manifestKeys}]`,
			phase: 'Final Outcome',
			status: ok ? 'ok' : 'fail',
		});
	} else {
		steps.push({
			detail: 'no summary — outcome unknown',
			phase: 'Final Outcome',
			status: 'skip',
		});
	}

	return steps;
}

// Infer context strategy from context.md header text (best-effort).
function inferStrategy(lines) {
	for (const line of lines.slice(0, 20)) {
		const l = line.toLowerCase();
		if (l.includes('inspection-aware')) return 'inspection-aware';
		if (l.includes('whole-file')) return 'whole-file';
		if (l.includes('file-map')) return 'file-map';
	}
	return 'unknown';
}

// ---------------------------------------------------------------------------
// CLI renderer
// ---------------------------------------------------------------------------

const STATUS_ICON = {
	fail: '\x1b[31m✖\x1b[0m',
	ok: '\x1b[32m✔\x1b[0m',
	skip: '\x1b[2m–\x1b[0m',
	warn: '\x1b[33m⚠\x1b[0m',
};

const STATUS_LABEL = {
	fail: '\x1b[31mFAIL\x1b[0m',
	ok: '\x1b[32m ok \x1b[0m',
	skip: '\x1b[2mskip\x1b[0m',
	warn: '\x1b[33mwarn\x1b[0m',
};

/**
 * Render the causal story for CLI output (with ANSI colour).
 *
 * @param {object} analysis
 * @param {StoryStep[]} story
 * @returns {string}
 */
export function renderForensicsCli(analysis, story) {
	const { runDir } = analysis;
	const runId = basename(runDir);
	const lines = [];

	lines.push(`\x1b[1mRun forensics: ${runId}\x1b[0m`);
	lines.push(`  dir: ${runDir}`);
	lines.push('');

	for (const step of story) {
		const icon = STATUS_ICON[step.status] ?? '?';
		const label = STATUS_LABEL[step.status] ?? step.status;
		lines.push(`  ${icon} [${label}] \x1b[1m${step.phase}\x1b[0m`);
		lines.push(`         ${step.detail}`);
		if (step.artifactPath) {
			lines.push(`         \x1b[2m→ ${step.artifactPath}\x1b[0m`);
		}
	}

	lines.push('');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

/**
 * Render a minimal, self-contained HTML page for the run-viewer.
 * No external dependencies — inline CSS only.
 *
 * @param {object} analysis
 * @param {StoryStep[]} story
 * @returns {string}
 */
export function renderForensicsHtml(analysis, story) {
	const { runDir, summary } = analysis;
	const runId = basename(runDir);
	const ts = summary?.timestamp || '';
	const model = summary?.model || '?';
	const ok = summary?.ok;
	const okLabel =
		ok === true ? '✔ ok' : ok === false ? '✖ failed' : '? unknown';
	const okClass = ok === true ? 'ok' : ok === false ? 'fail' : 'skip';

	const stepsHtml = story
		.map((step) => {
			const cls = step.status;
			const icon =
				{ fail: '✖', ok: '✔', skip: '–', warn: '⚠' }[step.status] ?? '?';
			const artifactHtml = step.artifactPath
				? `<div class="artifact">${esc(step.artifactPath)}</div>`
				: '';
			return `
      <div class="step ${cls}">
        <div class="step-header">
          <span class="icon">${icon}</span>
          <span class="phase">${esc(step.phase)}</span>
          <span class="badge ${cls}">${esc(step.status)}</span>
        </div>
        <div class="detail">${esc(step.detail)}</div>
        ${artifactHtml}
      </div>`;
		})
		.join('\n');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kodr run forensics: ${esc(runId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', monospace;
         font-size: 13px; background: #0d1117; color: #c9d1d9; padding: 24px; }
  h1 { font-size: 16px; color: #e6edf3; margin-bottom: 4px; }
  .meta { color: #8b949e; font-size: 12px; margin-bottom: 20px; }
  .meta .outcome { font-weight: bold; margin-left: 8px; }
  .meta .outcome.ok { color: #3fb950; }
  .meta .outcome.fail { color: #f85149; }
  .meta .outcome.skip { color: #8b949e; }
  .step { border: 1px solid #21262d; border-radius: 6px; padding: 12px 14px;
          margin-bottom: 10px; background: #161b22; }
  .step.ok   { border-left: 3px solid #3fb950; }
  .step.fail { border-left: 3px solid #f85149; }
  .step.warn { border-left: 3px solid #d29922; }
  .step.skip { border-left: 3px solid #30363d; }
  .step-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .icon { font-size: 14px; width: 16px; text-align: center; }
  .step.ok   .icon { color: #3fb950; }
  .step.fail .icon { color: #f85149; }
  .step.warn .icon { color: #d29922; }
  .step.skip .icon { color: #6e7681; }
  .phase { font-weight: bold; color: #e6edf3; flex: 1; }
  .badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: .04em; }
  .badge.ok   { background: #1f4021; color: #3fb950; }
  .badge.fail { background: #4c1318; color: #f85149; }
  .badge.warn { background: #3d2d00; color: #d29922; }
  .badge.skip { background: #1c2128; color: #6e7681; }
  .detail { color: #8b949e; word-break: break-all; }
  .artifact { margin-top: 4px; font-size: 11px; color: #30363d; word-break: break-all; }
  .artifact::before { content: '→ '; }
</style>
</head>
<body>
<h1>Run forensics: ${esc(runId)}</h1>
<div class="meta">
  model: ${esc(model)}
  ${ts ? `&nbsp;·&nbsp; ${esc(ts)}` : ''}
  <span class="outcome ${okClass}">${esc(okLabel)}</span>
</div>
${stepsHtml}
</body>
</html>`;
}

function esc(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Run directory resolver
// ---------------------------------------------------------------------------

/**
 * Resolve a run directory from user input:
 * - If given an absolute path, use it directly.
 * - If given a relative or timestamp-style string, look under .kodr/runs/.
 * - If empty / 'last', read .kodr/last-run.
 *
 * @param {string} cwd
 * @param {string} [runIdOrPath]
 * @returns {Promise<string>}  Absolute path to the run directory.
 */
export async function resolveRunDir(cwd, runIdOrPath) {
	const arg = (runIdOrPath || '').trim();

	if (!arg || arg === 'last') {
		const lastRunPath = join(cwd, '.kodr', 'last-run');
		let lastRunText;
		try {
			lastRunText = await readFile(lastRunPath, 'utf8');
		} catch {
			throw new Error(
				`No run specified and .kodr/last-run not found. Run kodr at least once or pass a run directory.`,
			);
		}
		const resolved = lastRunText.trim();
		if (!resolved) {
			throw new Error('.kodr/last-run is empty');
		}
		// last-run may be absolute or relative to cwd
		return resolved.startsWith('/') ? resolved : join(cwd, resolved);
	}

	// Absolute path given directly
	if (arg.startsWith('/')) {
		await assertRunDir(arg);
		return arg;
	}

	// F5: an argument containing a path separator is treated as a path and
	// resolved against cwd, not joined under .kodr/runs/.
	if (arg.includes(sep) || arg.includes('/')) {
		const resolved = resolve(cwd, arg);
		await assertRunDir(resolved);
		return resolved;
	}

	// Bare ID — look under .kodr/runs/
	const candidate = join(cwd, '.kodr', 'runs', arg);
	return candidate;
}

// Throw a clear error when a resolved directory has none of the known run
// artifacts, so `kodr why` surfaces the problem instead of an all-skip story.
async function assertRunDir(dir) {
	const KNOWN_ARTIFACTS = ['summary.json', 'error.json', 'prompt.md'];
	for (const name of KNOWN_ARTIFACTS) {
		try {
			await readFile(join(dir, name), 'utf8');
			return; // at least one artifact present — looks like a run dir
		} catch {
			// not found, try the next
		}
	}
	throw new Error(`not a kodr run directory: ${dir}`);
}
