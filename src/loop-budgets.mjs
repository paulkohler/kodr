export class LoopBudgetError extends Error {
	constructor(message, state) {
		super(message);
		this.name = 'LoopBudgetError';
		this.state = state;
	}
}

export function createLoopBudget(options = {}) {
	const state = {
		costUsd: 0,
		maxCostUsd: numberOrInfinity(options.maxCostUsd),
		maxRetries: integerOrInfinity(options.maxRetries),
		maxTokens: integerOrInfinity(options.maxTokens),
		maxTurns: integerOrInfinity(options.maxTurns),
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
			state.tokens += usageTokens(usage);
			state.costUsd += Number(usage.costUsd || 0);
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
	return {
		costUsd: state.costUsd,
		maxCostUsd: finiteOrNull(state.maxCostUsd),
		maxRetries: finiteOrNull(state.maxRetries),
		maxTokens: finiteOrNull(state.maxTokens),
		maxTurns: finiteOrNull(state.maxTurns),
		retries: state.retries,
		stopReason: state.stopReason,
		tokens: state.tokens,
		turns: state.turns,
	};
}

function finiteOrNull(value) {
	return Number.isFinite(value) ? value : null;
}
