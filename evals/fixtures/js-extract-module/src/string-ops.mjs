// Duplicated title-casing logic — needs extracting to src/utils.mjs

export function formatName(s) {
	if (typeof s !== 'string') return '';
	return s
		.trim()
		.toLowerCase()
		.replace(/\b\w/gu, (c) => c.toUpperCase());
}

export function formatTitle(s) {
	if (typeof s !== 'string') return '';
	return s
		.trim()
		.toLowerCase()
		.replace(/\b\w/gu, (c) => c.toUpperCase());
}
