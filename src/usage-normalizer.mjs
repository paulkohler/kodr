export function normalizeModelUsage(provider, usage = null, options = {}) {
	if (!usage) {
		return usage;
	}

	if (provider === 'local' || !provider) {
		return {
			...usage,
			cost: 0,
			costUsd: 0,
		};
	}

	if (provider === 'openrouter') {
		const cost = Number(usage.cost ?? usage.costUsd ?? 0);
		return {
			...usage,
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
		...usage,
		cost: 0,
		costUsd: 0,
	};
}
