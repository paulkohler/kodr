import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createRunArtifacts, writeJson, writeText } from './artifacts.mjs';
import { createLoopBudget } from './loop-budgets.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
	firstFinishReason,
} from './model-client.mjs';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_EXTRA_HEADERS = {
	'HTTP-Referer': 'https://github.com/pkohler/koder',
	'X-Title': 'kodr',
};

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

async function runOneModel(options, prompt, systemPrompt) {
	const budget = createLoopBudget({
		maxCostUsd: options.maxCostUsd,
		maxRetries: options.maxRetries,
		maxTokens: options.maxTokens,
		maxTurns: options.maxTurns,
	});

	const messages = [
		{ content: systemPrompt, role: 'system' },
		{ content: prompt, role: 'user' },
	];
	const responses = [];
	const finishReasons = [];
	const chunks = [];
	const startMs = Date.now();

	while (true) {
		budget.beforeTurn();
		const chatResponse = await createChatCompletion(options, {
			messages,
			model: options.model,
			temperature: 0,
		});
		budget.recordUsage(chatResponse.body?.usage);

		const content = firstAssistantMessage(chatResponse.body);
		if (!content) {
			throw new Error(
				'POST /chat/completions did not return a usable assistant message',
			);
		}

		const finishReason = firstFinishReason(chatResponse.body);
		responses.push(chatResponse.body);
		finishReasons.push(finishReason);
		chunks.push(content);

		if (finishReason !== 'length') {
			budget.stop(finishReason ? `finish_${finishReason}` : 'finish_unknown');
			break;
		}

		budget.recordRetry();
		messages.push({ content, role: 'assistant' });
		messages.push({
			content: 'Continue from exactly where you stopped.',
			role: 'user',
		});
	}

	return {
		durationMs: Date.now() - startMs,
		finishReasons,
		loopBudget: budget.snapshot(),
		responses,
		text: chunks.join(''),
	};
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
			const completion = await runOneModel(modelOptions, prompt, systemPrompt);
			result = {
				modelSpec: spec,
				provider,
				modelId,
				ok: true,
				finishReasons: completion.finishReasons,
				loopBudget: completion.loopBudget,
				responseChars: completion.text.length,
				durationMs: completion.durationMs,
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
