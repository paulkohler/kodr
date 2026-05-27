import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from './artifacts.mjs';

export class ReplayError extends Error {
	constructor(message) {
		super(message);
		this.name = 'ReplayError';
	}
}

export async function replayRun(runDir) {
	const prompt = await readTextArtifact(runDir, 'prompt.md');
	const response = await readTextArtifact(runDir, 'response.md');
	const summary = await readJsonArtifact(runDir, 'summary.json');
	const raw = await readJsonArtifact(runDir, 'raw-response.json');

	return {
		prompt,
		raw,
		response,
		summary,
	};
}

async function readTextArtifact(runDir, name) {
	try {
		return await readFile(join(runDir, name), 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			throw new ReplayError(`Replay artifact is missing: ${name}`);
		}
		throw new ReplayError(`Replay artifact could not be read: ${name}`);
	}
}

async function readJsonArtifact(runDir, name) {
	const text = await readTextArtifact(runDir, name);
	try {
		return JSON.parse(text);
	} catch {
		throw new ReplayError(`Replay artifact is invalid JSON: ${name}`);
	}
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

	await mkdir(join(cwd, '.kodr'), { recursive: true });
	await writeJson(join(cwd, '.kodr', 'comparison.json'), comparison);
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
