import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './artifacts.mjs';

export async function replayRun(runDir) {
	const prompt = await readFile(join(runDir, 'prompt.md'), 'utf8');
	const response = await readFile(join(runDir, 'response.md'), 'utf8');
	const summary = JSON.parse(
		await readFile(join(runDir, 'summary.json'), 'utf8'),
	);
	const raw = JSON.parse(
		await readFile(join(runDir, 'raw-response.json'), 'utf8'),
	);

	return {
		prompt,
		raw,
		response,
		summary,
	};
}

export async function compareModels(cwd, prompt, modelIds, runModel) {
	const results = [];

	for (const model of modelIds) {
		const result = await runModel(model, prompt);
		results.push({
			model,
			response: result.response,
			responseChars: result.response.length,
		});
	}

	const comparison = {
		models: results,
		prompt,
	};

	await mkdir(join(cwd, '.koder'), { recursive: true });
	await writeJson(join(cwd, '.koder', 'comparison.json'), comparison);
	await appendExperiment(cwd, {
		models: modelIds,
		promptChars: prompt.length,
		resultCount: results.length,
	});

	return comparison;
}

async function appendExperiment(cwd, metadata) {
	const line = `${JSON.stringify({
		...metadata,
		recordedAt: new Date().toISOString(),
	})}\n`;
	await writeFile(join(cwd, 'process', 'experiments.jsonl'), line, {
		flag: 'a',
	});
}
