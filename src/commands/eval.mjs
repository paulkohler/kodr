// commands/eval.mjs — run an eval suite (workspace + proposal cases) and write
// results. Extracted from app.mjs main() in phase 148 (app split). Takes
// runPrompt as an injected dependency (it stays in app.mjs) so this module
// never imports from app.mjs. Verbatim body, exact (options, io) → result
// contract.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRunArtifacts, writeJson } from '../artifacts.mjs';
import { CliError } from '../cli-errors.mjs';
import { workspaceContextOptions } from '../cli/options.mjs';
import { completeWithContinuations } from '../completion.mjs';
import { buildWorkspaceContext } from '../context-packer.mjs';
import { isWorkspaceCase, loadEvalSuite, scoreCase } from '../eval.mjs';
import { recordResults, runWorkspaceCase } from '../eval-runner.mjs';
import { extractProposal } from '../json-extractor.mjs';
import { loadMemory } from '../memory.mjs';
import { derivePromptId } from '../prompt-id.mjs';
import { jailedPath } from '../safe-writes.mjs';

export async function runEval(options, io, runPrompt) {
	if (!options.suitePath) {
		throw new CliError('kodr eval requires --suite');
	}
	const suitePath = await jailedPath(io.cwd, options.suitePath);
	const suiteText = await readFile(suitePath.absolute, 'utf8');
	const suite = loadEvalSuite(suiteText);
	const suiteDir = dirname(suitePath.absolute);

	const filterIds =
		options.evalCases.length > 0 ? new Set(options.evalCases) : null;

	const runDir = await createRunArtifacts(io.cwd, options.out);
	const memory = await loadMemory(io.cwd);
	// Phase 250: intentionally two-arg — eval builds a suite-level base context
	// for proposal cases only. Each case's own evalCase.prompt is the task; there
	// is no single CLI prompt to thread here, and workspace cases re-derive their
	// own context inside runWorkspaceCase. options.prompt is typically unset for
	// eval runs. Passing undefined falls through to the existing behaviour.
	const context = await buildWorkspaceContext(io.cwd, {
		memory,
		...workspaceContextOptions(options, io.cwd),
	});

	const caseResults = [];

	for (const evalCase of suite.cases) {
		if (filterIds && !filterIds.has(evalCase.id)) continue;

		if (isWorkspaceCase(evalCase)) {
			// Workspace case: run through the real pipeline in a staged fixture dir
			const workspaceOptions = {
				...options,
				_runPrompt: runPrompt,
			};
			const result = await runWorkspaceCase(
				evalCase,
				suiteDir,
				workspaceOptions,
				io,
				runDir,
			);
			caseResults.push(result);

			if (!options.json) {
				const status =
					result.status === 'skipped'
						? `skip (${result.reason})`
						: result.status === 'fixture-invalid'
							? `fixture-invalid`
							: result.ok
								? 'pass'
								: 'fail';
				const score =
					result.score !== undefined && result.score !== null
						? ` (score ${result.score.toFixed(2)})`
						: '';
				io.stdout.write(`  ${result.id}: ${status}${score}\n`);
			}
		} else {
			// Proposal case: existing completion-only path
			const model = evalCase.model || options.model;
			const caseOptions = { ...options, model };

			let proposal = null;
			let completionError = null;
			let finishReasons = [];
			let responseChars = 0;

			try {
				const completion = await completeWithContinuations(
					caseOptions,
					model,
					evalCase.prompt,
					context.systemPrompt,
				);
				finishReasons = completion.finishReasons;
				responseChars = completion.text.length;
				proposal = extractProposal(completion.text);
			} catch (error) {
				completionError = { message: error.message, name: error.name };
			}

			const scored = await scoreCase(evalCase, proposal, options.timeoutMs);
			const result = {
				...scored,
				completionError,
				finishReasons,
				model,
				proposalFound: proposal !== null,
				responseChars,
				status: 'ran',
			};
			caseResults.push(result);

			if (!options.json) {
				const status = result.ok ? 'pass' : 'fail';
				io.stdout.write(
					`  ${result.id}: ${status} (${result.passCount}/${result.totalCount}, score ${result.score.toFixed(2)})\n`,
				);
			}
		}
	}

	// Score over non-skipped, non-fixture-invalid cases
	const scoredResults = caseResults.filter((r) => r.status === 'ran');
	const skippedResults = caseResults.filter(
		(r) => r.status === 'skipped' || r.status === 'fixture-invalid',
	);
	const passCount = scoredResults.filter((r) => r.ok).length;
	const totalCount = scoredResults.length;
	const score = totalCount > 0 ? passCount / totalCount : 1;

	const evalResults = {
		name: suite.name,
		ok: passCount === totalCount && skippedResults.length === 0,
		score,
		cases: caseResults,
		passCount,
		totalCount,
		skippedCount: skippedResults.length,
		timestamp: new Date().toISOString(),
	};

	await writeJson(join(runDir, 'eval-results.json'), evalResults);

	if (options.record) {
		const promptIds = new Map();
		for (const evalCase of suite.cases) {
			promptIds.set(evalCase.id, derivePromptId(evalCase.prompt));
		}
		await recordResults(
			io.cwd,
			suite.name,
			options.model,
			caseResults,
			promptIds,
		);
	}

	if (options.json) {
		io.stdout.write(`${JSON.stringify(evalResults, null, 2)}\n`);
	} else {
		io.stdout.write(`Eval: ${suite.name}\n`);
		io.stdout.write(`Run: ${runDir}\n`);
		if (skippedResults.length > 0) {
			for (const c of skippedResults) {
				io.stdout.write(`  ${c.id}: ${c.status} — ${c.reason || ''}\n`);
			}
		}
		io.stdout.write(
			`Overall: ${passCount}/${totalCount} cases passed (score ${score.toFixed(2)})`,
		);
		if (skippedResults.length > 0) {
			io.stdout.write(`, ${skippedResults.length} skipped/invalid`);
		}
		io.stdout.write('\n');
	}

	return { ok: evalResults.ok, command: 'eval', evalResults, runDir };
}
