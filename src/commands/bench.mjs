// commands/bench.mjs — run an eval suite across all discovered models and save
// scores + a routing table. Extracted from app.mjs main() in phase 148 (app
// split). Takes runPrompt as an injected dependency (it stays in app.mjs) so
// this module never imports from app.mjs. Verbatim body, exact I/O contract.

import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRunArtifacts } from '../artifacts.mjs';
import {
	computeRoutingTable,
	discoverModels,
	loadBenchScores,
	renderBenchResults,
	saveBenchScores,
	saveRoutingTable,
} from '../bench.mjs';
import { CliError } from '../cli-errors.mjs';
import { loadEvalSuite } from '../eval.mjs';
import { runWorkspaceSuite } from '../eval-runner.mjs';
import { jailedPath } from '../safe-writes.mjs';

export async function runBench(options, io, runPrompt) {
	if (!options.suitePath) {
		throw new CliError('kodr bench requires --suite');
	}
	const suitePath = await jailedPath(io.cwd, options.suitePath);
	const suiteText = await readFile(suitePath.absolute, 'utf8');
	const suite = loadEvalSuite(suiteText);
	const suiteDir = dirname(suitePath.absolute);

	const models = await discoverModels(options.baseUrl, options.timeoutMs);
	if (models.length === 0) {
		throw new CliError(
			`No models found at ${options.baseUrl}. Is LM Studio running?`,
		);
	}

	if (!options.json) {
		io.stdout.write(`Bench: ${suite.name}\n`);
		io.stdout.write(`Models: ${models.join(', ')}\n`);
	}

	const runDir = await createRunArtifacts(io.cwd, options.out);
	const existingScores = await loadBenchScores(io.cwd);

	for (const modelId of models) {
		if (!options.json) {
			io.stdout.write(`\nRunning suite against: ${modelId}\n`);
		}
		const modelOptions = {
			...options,
			model: modelId,
			_runPrompt: runPrompt,
		};

		const caseResults = await runWorkspaceSuite(
			suite,
			suiteDir,
			modelOptions,
			io,
			runDir,
			null,
		);

		const ranCases = caseResults.filter((r) => r.status === 'ran');
		const passCount = ranCases.filter((r) => r.ok).length;
		const totalCount = ranCases.length;
		const score = totalCount > 0 ? passCount / totalCount : 0;
		const editFormat =
			ranCases.length > 0 ? (ranCases[0].editFormat ?? 'patch') : 'patch';

		const entry = {
			score,
			passCount,
			totalCount,
			timestamp: new Date().toISOString(),
			editFormat,
		};
		existingScores.set(modelId, entry);

		if (!options.json) {
			io.stdout.write(
				`  ${modelId}: ${passCount}/${totalCount} (score ${score.toFixed(2)})\n`,
			);
		}
	}

	await saveBenchScores(io.cwd, existingScores);

	const routingTable = computeRoutingTable(existingScores);
	await saveRoutingTable(io.cwd, routingTable);

	const benchResults = {
		suite: suite.name,
		models: Object.fromEntries(existingScores),
		routingTable,
		timestamp: new Date().toISOString(),
	};

	if (options.json) {
		io.stdout.write(`${JSON.stringify(benchResults, null, 2)}\n`);
	} else {
		io.stdout.write(`\n${renderBenchResults(existingScores, routingTable)}`);
		io.stdout.write(`Scores saved to .kodr/bench-scores.json\n`);
		io.stdout.write(`Routing saved to .kodr/routing.json\n`);
	}

	return { ok: true, command: 'bench', benchResults };
}
