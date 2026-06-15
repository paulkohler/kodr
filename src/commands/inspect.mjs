// commands/inspect.mjs — repomap inspection & external-tool registry commands.
// Extracted from app.mjs main() in phase 148 (app split). Verbatim bodies,
// exact (options, io) → result contract.

import { jailedPath } from '../safe-writes.mjs';
import { inspectWorkspace } from '../repomap/index.mjs';
import {
	filterInspectionIndex,
	renderInspection,
} from '../inspection-output.mjs';
import {
	checkAvailability,
	REGISTRY,
} from '../external-inspector-registry.mjs';

export async function runInspect(options, io) {
	if (options.inspectFile) {
		await jailedPath(io.cwd, options.inspectFile);
	}
	const index = await inspectWorkspace(io.cwd, {
		languages:
			options.inspectLanguages.length > 0
				? options.inspectLanguages
				: undefined,
		symbol: options.inspectSymbol,
	});
	const filteredIndex = filterInspectionIndex(index, {
		filePath: options.inspectFile,
	});
	if (options.json) {
		io.stdout.write(`${JSON.stringify(filteredIndex, null, 2)}\n`);
	} else {
		io.stdout.write(
			renderInspection(filteredIndex, {
				filePath: options.inspectFile,
				symbolName: options.inspectSymbol,
			}),
		);
	}
	return { ok: true, command: 'inspect', index: filteredIndex };
}

export async function runRegistry(options, io) {
	const results = await Promise.all(
		REGISTRY.map(async (entry) => ({
			available: await checkAvailability(entry.command),
			languages: entry.languages,
			name: entry.name,
		})),
	);
	if (options.json) {
		io.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
	} else {
		for (const entry of results) {
			const mark = entry.available ? '✓' : '✗';
			const langs = entry.languages.join(',');
			io.stdout.write(`${entry.name.padEnd(36)}${langs.padEnd(24)}${mark}\n`);
		}
	}
	return { ok: true, command: 'registry', results };
}
