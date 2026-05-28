import { createLoopBudget } from './loop-budgets.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
	firstFinishReason,
} from './model-client.mjs';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_EXTRA_HEADERS = {
	'HTTP-Referer': 'https://github.com/pkohler/koder',
	'X-Title': 'kodr',
};

// Run a prompt through the model, handling length-truncated continuations.
// Returns { finishReasons, loopBudget, responses, text }.
export async function completeWithContinuations(
	options,
	model,
	prompt,
	systemPrompt,
) {
	const budget = createLoopBudget({
		maxCostUsd: options.maxCostUsd,
		maxRetries: options.maxRetries,
		maxTokens: options.maxTokens,
		maxTurns: options.maxTurns,
	});
	const responses = [];
	const finishReasons = [];
	const chunks = [];
	const messages = [
		{ content: systemPrompt, role: 'system' },
		{ content: prompt, role: 'user' },
	];

	while (true) {
		budget.beforeTurn();
		const chatResponse = await createChatCompletion(options, {
			messages,
			model,
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
			return {
				finishReasons,
				loopBudget: budget.snapshot(),
				messages,
				responses,
				text: chunks.join(''),
			};
		}

		budget.recordRetry();
		messages.push({ content, role: 'assistant' });
		messages.push({
			content: 'Continue from exactly where you stopped.',
			role: 'user',
		});
	}
}
