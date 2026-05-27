import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunArtifacts, writeJson, writeText } from './artifacts.mjs';
import {
	completeWithContinuations,
	OPENROUTER_BASE_URL,
	OPENROUTER_EXTRA_HEADERS,
} from './completion.mjs';

// "openrouter:openai/gpt-4o-mini" → { provider: 'openrouter', modelId: 'openai/gpt-4o-mini' }
// "qwen/qwen3.6-35b-a3b"         → { provider: 'local',      modelId: 'qwen/qwen3.6-35b-a3b' }
export function parseModelSpec(spec) {
	if (spec.startsWith('openrouter:')) {
		return {
			provider: 'openrouter',
			modelId: spec.slice('openrouter:'.length),
		};
	}
	return { provider: 'local', modelId: spec };
}

export function buildModelOptions(baseOptions, { provider, modelId }, env) {
	if (provider === 'openrouter') {
		const apiKey =
			(env && (env.OPENROUTER_API_KEY || env.OPENAI_API_KEY)) || '';
		return {
			...baseOptions,
			apiKey,
			baseUrl: OPENROUTER_BASE_URL,
			extraHeaders: OPENROUTER_EXTRA_HEADERS,
			model: modelId,
		};
	}
	return { ...baseOptions, model: modelId };
}

function sanitizeModelId(modelId) {
	return modelId.replace(/[/: ]/gu, '_');
}

export async function runComparison(
	baseOptions,
	env,
	prompt,
	systemPrompt,
	modelSpecs,
	cwd,
	out,
) {
	const compDir = await createRunArtifacts(cwd, out);
	const results = [];

	for (const spec of modelSpecs) {
		const parsed = parseModelSpec(spec);
		const { provider, modelId } = parsed;
		const modelOptions = buildModelOptions(baseOptions, parsed, env);
		const modelDir = join(compDir, sanitizeModelId(modelId));
		await mkdir(modelDir, { recursive: true });

		let result;
		try {
			const startMs = Date.now();
			const completion = await completeWithContinuations(
				modelOptions,
				modelOptions.model,
				prompt,
				systemPrompt,
			);
			result = {
				modelSpec: spec,
				provider,
				modelId,
				ok: true,
				finishReasons: completion.finishReasons,
				loopBudget: completion.loopBudget,
				responseChars: completion.text.length,
				durationMs: Date.now() - startMs,
				error: null,
				runDir: modelDir,
			};
			await writeText(join(modelDir, 'response.md'), completion.text);
			await writeJson(join(modelDir, 'raw-response.json'), {
				responses: completion.responses,
			});
		} catch (error) {
			result = {
				modelSpec: spec,
				provider,
				modelId,
				ok: false,
				finishReasons: [],
				loopBudget: null,
				responseChars: 0,
				durationMs: 0,
				error: { message: error.message, name: error.name },
				runDir: modelDir,
			};
			await writeText(join(modelDir, 'response.md'), '');
			await writeJson(join(modelDir, 'raw-response.json'), { responses: [] });
		}

		await writeJson(join(modelDir, 'result.json'), result);
		results.push(result);
	}

	const comparison = {
		models: results,
		prompt,
		timestamp: new Date().toISOString(),
	};
	await writeJson(join(compDir, 'comparison.json'), comparison);

	return { compDir, comparison };
}
