const KIND_WEIGHT = {
	class: 4,
	function: 5,
	test: 1,
	variable: 2,
};

export function rankSymbols(index, options = {}) {
	const symbols = index.symbols || [];
	const terms = queryTerms(options.query || '');
	const references = referenceCounts(index, symbols);

	return symbols
		.map((symbol, order) => {
			const referenceCount = references.get(symbol.name) || 0;
			const queryScore = scoreQueryMatch(symbol, terms);
			const kindWeight = KIND_WEIGHT[symbol.kind] || 0;
			const score = queryScore + Math.min(referenceCount, 20) * 5 + kindWeight;
			return {
				...symbol,
				rank: {
					kindWeight,
					queryScore,
					referenceCount,
					score,
				},
				_rankOrder: order,
			};
		})
		.sort(compareRankedSymbols)
		.map(({ _rankOrder, ...symbol }) => symbol);
}

function compareRankedSymbols(left, right) {
	return (
		right.rank.score - left.rank.score ||
		right.rank.queryScore - left.rank.queryScore ||
		right.rank.referenceCount - left.rank.referenceCount ||
		left.path.localeCompare(right.path) ||
		left.lineStart - right.lineStart ||
		left.name.localeCompare(right.name)
	);
}

function referenceCounts(index, symbols) {
	const names = [
		...new Set(symbols.map((symbol) => symbol.name).filter(Boolean)),
	];
	const patterns = names.map((name) => ({
		name,
		pattern: new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gu'),
	}));
	const counts = new Map(names.map((name) => [name, 0]));

	for (const file of index.files || []) {
		const lines = file._contentLines || [];
		for (const line of lines) {
			for (const { name, pattern } of patterns) {
				pattern.lastIndex = 0;
				const matches = line.text.match(pattern);
				if (matches) {
					counts.set(name, counts.get(name) + matches.length);
				}
			}
		}
	}

	return counts;
}

function scoreQueryMatch(symbol, terms) {
	if (terms.length === 0) {
		return 0;
	}

	const normalizedName = normalizeSymbolName(symbol.name);
	const nameTokens = normalizeTokens(symbol.name);
	const pathTokens = normalizeTokens(symbol.path || '');

	let score = 0;
	for (const term of terms) {
		if (normalizedName === term) {
			score = Math.max(score, 100);
		} else if (normalizedName.includes(term)) {
			score = Math.max(score, 80);
		} else if (nameTokens.includes(term)) {
			score = Math.max(score, 60);
		} else if (pathTokens.includes(term)) {
			score = Math.max(score, 20);
		}
	}
	return score;
}

function queryTerms(query) {
	return normalizeTokens(query)
		.filter((token) => token.length >= 3)
		.slice(0, 20);
}

function normalizeSymbolName(value) {
	return normalizeTokens(value).join('');
}

function normalizeTokens(value) {
	return String(value || '')
		.replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
