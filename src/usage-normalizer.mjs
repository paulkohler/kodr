import { isLocalCostFreeModel } from './model-client.mjs';

export function normalizeModelUsage(provider, usage = null, options = {}) {
	if (!usage) {
		return usage;
	}

	const normalized = {
		...usage,
		...normalizeTokenFields(usage),
		...normalizeCacheFields(usage),
	};

	if (isLocalCostFreeModel({ provider }, options.model)) {
		return {
			...normalized,
			cost: 0,
			costUsd: 0,
		};
	}

	if (provider === 'openrouter') {
		const cost = Number(usage.cost ?? usage.costUsd ?? 0);
		return {
			...normalized,
			cost,
			costUsd: cost,
		};
	}

	if (provider === 'ollama') {
		const cost = Number(usage.cost ?? usage.costUsd ?? 0);
		return {
			...normalized,
			cost,
			costUsd: cost,
		};
	}

	if (options.maxCostUsd !== undefined && options.maxCostUsd !== '') {
		throw new Error(
			`--max-cost-usd is not supported for provider "${provider}"`,
		);
	}

	return {
		...normalized,
		cost: 0,
		costUsd: 0,
	};
}

function normalizeTokenFields(usage) {
	const promptTokens = Number(
		usage.prompt_tokens ?? usage.promptTokens ?? usage.input_tokens ?? 0,
	);
	const completionTokens = Number(
		usage.completion_tokens ??
			usage.completionTokens ??
			usage.output_tokens ??
			0,
	);
	const tokens = Number(
		usage.total_tokens ??
			usage.totalTokens ??
			(promptTokens || completionTokens ? promptTokens + completionTokens : 0),
	);
	const fields = {};
	if (promptTokens > 0) {
		fields.promptTokens = promptTokens;
		fields.prompt_tokens = usage.prompt_tokens ?? promptTokens;
	}
	if (completionTokens > 0) {
		fields.completionTokens = completionTokens;
		fields.completion_tokens = usage.completion_tokens ?? completionTokens;
	}
	if (tokens > 0) {
		fields.tokens = tokens;
		fields.total_tokens = usage.total_tokens ?? tokens;
	}
	return fields;
}

function normalizeCacheFields(usage) {
	const promptDetails = usage.prompt_tokens_details || {};
	const cachedTokens = Number(
		usage.cachedTokens ?? promptDetails.cached_tokens ?? 0,
	);
	const cacheReadTokens = Number(
		usage.cacheReadTokens ?? usage.cache_read_input_tokens ?? cachedTokens,
	);
	const cacheWriteTokens = Number(
		usage.cacheWriteTokens ??
			usage.cache_creation_input_tokens ??
			promptDetails.cache_write_tokens ??
			0,
	);
	const fields = {};
	if (cachedTokens > 0) {
		fields.cachedTokens = cachedTokens;
	}
	if (cacheReadTokens > 0) {
		fields.cacheReadTokens = cacheReadTokens;
	}
	if (cacheWriteTokens > 0) {
		fields.cacheWriteTokens = cacheWriteTokens;
	}
	return fields;
}
