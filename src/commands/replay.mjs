// commands/replay.mjs — deterministic run replay & cycle-review subagent
// commands. Extracted from app.mjs main() in phase 148 (app split). Verbatim
// bodies, exact (options, io) → result contract.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunArtifacts, writeJson } from '../artifacts.mjs';
import { CliError } from '../cli-errors.mjs';
import { jailedPath } from '../safe-writes.mjs';
import { replayRun } from '../replay.mjs';
import { createCycleReviewRequest, runSubagent } from '../subagents.mjs';

export async function runReplay(options, io) {
	if (!options.replayDir) {
		throw new CliError('kodr replay requires a run directory');
	}
	const replayDir = await jailedPath(io.cwd, options.replayDir);
	const result = await replayRun(replayDir.absolute);
	io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	return { ok: true, command: 'replay', result };
}

export async function runCycleReview(options, io) {
	if (!options.transcriptFile) {
		throw new CliError('kodr cycle-review requires --transcript-file');
	}
	const runDir = await createRunArtifacts(io.cwd, options.out);
	const transcriptPath = await jailedPath(io.cwd, options.transcriptFile);
	const transcript = await readFile(transcriptPath.absolute, 'utf8');
	const review = await runSubagent(
		io.cwd,
		runDir,
		createCycleReviewRequest({
			transcript,
			transcriptPath: options.transcriptFile,
		}),
	);
	const result = {
		ok: review.result.ok,
		runDir,
		subagent: {
			artifactDir: review.artifactDir,
			id: review.request.id,
			kind: review.request.kind,
		},
		result: review.result,
	};
	await writeJson(join(runDir, 'summary.json'), {
		artifacts: {
			subagentRequest: 'subagents/cycle-review/request.json',
			subagentResult: 'subagents/cycle-review/result.json',
			summary: 'summary.json',
		},
		ok: result.ok,
		subagent: result.subagent,
	});
	if (options.json) {
		io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else {
		io.stdout.write(`Cycle review ok\n`);
		io.stdout.write(`Run: ${runDir}\n`);
		io.stdout.write(`Findings: ${review.result.findings.length}\n`);
	}
	return { ok: result.ok, command: 'cycle-review', result };
}
