import { lstat } from 'node:fs/promises';

const FILE_MAP_MAX_FILES = 200;
const INSPECTION_SUMMARY_MAX_FILES = 80;

/**
 * Build a file map object from a list of relative paths.
 * Includes size-in-bytes for each entry (from stat) and a count of hidden
 * files beyond the display cap.
 */
export async function buildFileMap(cwd, files) {
	const shown = files.slice(0, FILE_MAP_MAX_FILES);
	const hidden = files.length - shown.length;
	const entries = [];
	for (const file of shown) {
		try {
			const stat = await lstat(`${cwd}/${file}`);
			entries.push({ path: file, size: stat.size });
		} catch {
			entries.push({ path: file, size: 0 });
		}
	}
	return { entries, hidden, total: files.length };
}

/**
 * Render a file map object as a plain-text listing.
 */
export function renderFileMapText(fileMap) {
	const lines = fileMap.entries.map(
		({ path, size }) => `${path} (${size} bytes)`,
	);
	if (fileMap.hidden > 0) {
		lines.push(
			`... ${fileMap.hidden} more file${fileMap.hidden === 1 ? '' : 's'} — use list_files to explore`,
		);
	}
	return `Workspace files (${fileMap.total} total):\n${lines.join('\n')}\nUse read_file to read any file.`;
}

/**
 * Build compact per-file summaries for the inspection context header.
 * Capped at INSPECTION_SUMMARY_MAX_FILES entries, each with at most 12
 * symbol entries.
 */
export function buildFileSummaries(files) {
	return files.slice(0, INSPECTION_SUMMARY_MAX_FILES).map((file) => ({
		importCount: file.imports.length,
		language: file.language,
		lineCount: file.lineCount,
		path: file.path,
		symbols: file.symbols.slice(0, 12).map((symbol) => ({
			kind: symbol.kind,
			lineStart: symbol.lineStart,
			name: symbol.name,
		})),
	}));
}

/**
 * Render an inspection context object as a Markdown summary section.
 */
export function renderInspectionSummary(inspection) {
	const lines = [
		`## Inspection context`,
		'',
		`Mode: ${inspection.mode}`,
		`Files indexed: ${inspection.totalFileCount}`,
		`Symbols indexed: ${inspection.totalSymbolCount}`,
		`Selected symbols: ${inspection.selectedSymbolCount}`,
		`Selected chunks: ${inspection.chunks.length}`,
		`Dropped chunks: ${inspection.droppedChunks || 0}`,
		`Dropped chars: ${inspection.droppedChars || 0}`,
		'',
		'### File summaries',
	];
	for (const file of inspection.fileSummaries) {
		const symbols = file.symbols
			.map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.lineStart}`)
			.join(', ');
		lines.push(
			`- ${file.path} (${file.language}, ${file.lineCount} lines, ${file.importCount} imports)${symbols ? `: ${symbols}` : ''}`,
		);
	}
	if (inspection.chunks.length === 0) {
		lines.push('');
		lines.push(
			'No symbol-specific chunks selected; use file summaries as fallback.',
		);
	}
	return lines.join('\n');
}
