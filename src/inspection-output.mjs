export function filterInspectionIndex(index, options = {}) {
	const filePath = options.filePath || '';
	if (!filePath) {
		return index;
	}
	const files = index.files.filter((file) => file.path === filePath);
	const allowed = new Set(files.map((file) => file.path));
	const symbols = index.symbols.filter((symbol) => allowed.has(symbol.path));
	const references = (index.references || []).filter((reference) =>
		allowed.has(reference.path),
	);
	return {
		...index,
		files,
		languages: countLanguages(files),
		rankedSymbols: (index.rankedSymbols || []).filter((symbol) =>
			allowed.has(symbol.path),
		),
		references,
		symbols,
		totalFiles: files.length,
		totalSymbols: symbols.length,
	};
}

export function renderInspection(index, options = {}) {
	const symbolName = options.symbolName || '';
	const filePath = options.filePath || '';
	const lines = [
		`Code inspection: ${index.files.length} files, ${index.symbols.length} symbols`,
	];
	if (filePath) {
		lines.push(`File: ${filePath}`);
	}
	const languages = Object.entries(index.languages)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([language, count]) => `${language}=${count}`)
		.join(', ');
	if (languages) {
		lines.push(`Languages: ${languages}`);
	}

	for (const file of index.files) {
		lines.push('');
		lines.push(`${file.path} (${file.language})`);
		for (const symbol of file.symbols) {
			lines.push(
				`  ${symbol.kind} ${symbol.name} lines ${symbol.lineStart}-${symbol.lineEnd}`,
			);
		}
	}

	if (symbolName) {
		lines.push('');
		lines.push(renderReferences(index, symbolName).trimEnd());
	}

	return `${lines.join('\n')}\n`;
}

export function renderReferences(index, symbolName = '') {
	const lines = [`References for ${symbolName}: ${index.references.length}`];
	for (const reference of index.references) {
		lines.push(`  ${reference.path}:${reference.line} ${reference.text}`);
	}
	return `${lines.join('\n')}\n`;
}

function countLanguages(files) {
	const languages = {};
	for (const file of files) {
		languages[file.language] = (languages[file.language] || 0) + 1;
	}
	return languages;
}
