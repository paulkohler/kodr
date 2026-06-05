export class LoopBudgetError extends Error {
	constructor(message, state) {
		super(message);
		this.name = 'LoopBudgetError';
		this.state = state;
	}
}

export function createLoopBudget(options = {}) {
	const state = {
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		cachedTokens: 0,
		completionTokens: 0,
		cost: 0,
		costUsd: 0,
		maxCostUsd: numberOrInfinity(options.maxCostUsd),
		maxRetries: integerOrInfinity(options.maxRetries),
		maxTokens: integerOrInfinity(options.maxTokens),
		maxTurns: integerOrInfinity(options.maxTurns),
		promptTokens: 0,
		retries: 0,
		stopReason: '',
		tokens: 0,
		turns: 0,
	};

	return {
		state,
		beforeTurn() {
			if (state.turns >= state.maxTurns) {
				stop('turn_budget_exhausted');
			}
			state.turns += 1;
			return snapshot(state);
		},
		recordRetry() {
			if (state.retries >= state.maxRetries) {
				stop('retry_budget_exhausted');
			}
			state.retries += 1;
			return snapshot(state);
		},
		recordUsage(usage = {}) {
			usage = usage || {};
			const prompt = Number(usage.prompt_tokens || usage.promptTokens || 0);
			const completion = Number(
				usage.completion_tokens || usage.completionTokens || 0,
			);
			state.promptTokens += prompt;
			state.completionTokens += completion;
			state.cachedTokens += Number(usage.cachedTokens || 0);
			state.cacheReadTokens += Number(usage.cacheReadTokens || 0);
			state.cacheWriteTokens += Number(usage.cacheWriteTokens || 0);
			// usageTokens() prefers total_tokens when present. Some providers report
			// a total that differs from prompt+completion (cached tokens etc.), so
			// state.tokens may not equal the breakdown sum. Intentional: budgets
			// enforce the reported total; the split fields are display-only.
			state.tokens += usageTokens(usage);
			const cost = Number(usage.cost ?? usage.costUsd ?? 0);
			state.cost += cost;
			state.costUsd += cost;
			if (state.tokens > state.maxTokens) {
				stop('token_budget_exhausted');
			}
			if (state.costUsd > state.maxCostUsd) {
				stop('cost_budget_exhausted');
			}
			return snapshot(state);
		},
		stop(reason) {
			state.stopReason = reason;
			return snapshot(state);
		},
		snapshot() {
			return snapshot(state);
		},
	};

	function stop(reason) {
		state.stopReason = reason;
		throw new LoopBudgetError(
			`Loop budget stopped: ${reason}`,
			snapshot(state),
		);
	}
}

export function usageTokens(usage = {}) {
	const prompt = Number(usage.prompt_tokens || usage.promptTokens || 0);
	const completion = Number(
		usage.completion_tokens || usage.completionTokens || 0,
	);
	const total = Number(usage.total_tokens || usage.totalTokens || 0);
	return total || prompt + completion;
}

function integerOrInfinity(value) {
	if (value === undefined || value === null || value === '') {
		return Infinity;
	}
	const number = Number(value);
	if (!Number.isInteger(number) || number < 0) {
		throw new LoopBudgetError(
			'Loop budget values must be non-negative integers',
		);
	}
	return number;
}

function numberOrInfinity(value) {
	if (value === undefined || value === null || value === '') {
		return Infinity;
	}
	const number = Number(value);
	if (!Number.isFinite(number) || number < 0) {
		throw new LoopBudgetError('Loop cost budget must be a non-negative number');
	}
	return number;
}

function snapshot(state) {
	const result = {
		completionTokens: state.completionTokens,
		cost: state.cost,
		costUsd: state.costUsd,
		maxCostUsd: finiteOrNull(state.maxCostUsd),
		maxRetries: finiteOrNull(state.maxRetries),
		maxTokens: finiteOrNull(state.maxTokens),
		maxTurns: finiteOrNull(state.maxTurns),
		promptTokens: state.promptTokens,
		retries: state.retries,
		stopReason: state.stopReason,
		tokens: state.tokens,
		turns: state.turns,
	};
	if (state.cacheReadTokens > 0) {
		result.cacheReadTokens = state.cacheReadTokens;
	}
	if (state.cacheWriteTokens > 0) {
		result.cacheWriteTokens = state.cacheWriteTokens;
	}
	if (state.cachedTokens > 0) {
		result.cachedTokens = state.cachedTokens;
	}
	return result;
}

function finiteOrNull(value) {
	return Number.isFinite(value) ? value : null;
}
