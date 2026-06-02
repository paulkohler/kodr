import { createLoopBudget } from './loop-budgets.mjs';
import {
	createChatCompletion,
	firstAssistantMessage,
	firstFinishReason,
} from './model-client.mjs';
import { renderHookStopFeedback } from './command-hooks.mjs';
import { HookBlockedError } from './hooks.mjs';
import { normalizeModelUsage } from './usage-normalizer.mjs';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_EXTRA_HEADERS = {
	'HTTP-Referer': 'https://github.com/pkohler/koder',
	'X-Title': 'kodr',
};

// Run a prompt through the model, handling length-truncated continuations.
// Returns { finishReasons, loopBudget, messages, responses, text }.
// Pass initialMessages to resume a prior conversation (session continuation);
// otherwise pass systemPrompt + prompt and they are wrapped automatically.
export async function completeWithContinuations(
	options,
	model,
	prompt,
	systemPrompt,
	{ initialMessages } = {},
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
	const messages = initialMessages
		? [...initialMessages]
		: [
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
		budget.recordUsage(
			normalizeModelUsage(options.provider, chatResponse.body?.usage, {
				maxCostUsd: options.maxCostUsd,
			}),
		);
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
			const text = chunks.join('');
			// Append the final assistant turn so the returned messages array is a
			// complete conversation transcript (system → user → … → assistant).
			// Intermediate chunks are appended as partial assistant turns within
			// the length-continuation loop above; this entry holds the full text.
			messages.push({ content: text, role: 'assistant' });
			try {
				await options.hooks?.run('stop', {
					cwd: options.cwd || '',
					finishReason,
					response: text,
				});
			} catch (error) {
				if (error instanceof HookBlockedError) {
					messages.push({
						content: renderHookStopFeedback(error.message),
						role: 'user',
					});
					chunks.length = 0;
					continue;
				}
				throw error;
			}
			budget.stop(finishReason ? `finish_${finishReason}` : 'finish_unknown');
			return {
				finishReasons,
				loopBudget: budget.snapshot(),
				messages,
				responses,
				text,
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
