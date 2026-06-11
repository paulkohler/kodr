import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
	discoverInspectors,
	REGISTRY,
} from './external-inspector-registry.mjs';
import { runLspInspector } from './lsp-client.mjs';
import { classifyLanguage } from './repomap/inspector.mjs';

/**
 * Determine whether a registry LSP entry is allowed given the lsp option value.
 *
 * lspEnabled values:
 *   true | 'auto'  → all entries allowed
 *   string[]       → only entries whose name appears in the array
 *   anything else  → none allowed
 */
function lspEntryAllowed(entry, lspEnabled) {
	if (lspEnabled === true || lspEnabled === 'auto') return true;
	if (Array.isArray(lspEnabled)) return lspEnabled.includes(entry.name);
	return false;
}

/**
 * Re-inspect a specific set of workspace-relative file paths using available
 * LSP servers.
 *
 * @param {string}   cwd      - Workspace root (absolute path).
 * @param {string[]} paths    - Workspace-relative paths to inspect.
 * @param {object}   options  - { lsp, lspDiagWindow, lspInitTimeout,
 *                               lspRequestTimeout, lspRunBudget }
 * @param {object[]} registry - Inspector registry (defaults to REGISTRY).
 * @returns {object|null}
 */
export async function inspectChangedFiles(
	cwd,
	paths,
	options = {},
	registry = REGISTRY,
) {
	if (!options.lsp) return null;

	const start = performance.now();
	const skipped = [];
	const baseFiles = [];

	// Filter and build baseFiles
	for (const p of paths) {
		if (isAbsolute(p)) {
			skipped.push({ path: p, reason: 'absolute path not allowed' });
			continue;
		}
		if (p.split('/').includes('..') || p.includes('..')) {
			skipped.push({ path: p, reason: 'path traversal not allowed' });
			continue;
		}
		const language = classifyLanguage(p);
		if (language === 'unknown') {
			skipped.push({ path: p, reason: 'no inspectable language' });
			continue;
		}

		let content;
		try {
			content = await readFile(join(cwd, p), 'utf8');
		} catch (err) {
			skipped.push({ path: p, reason: `read failed: ${err.message}` });
			continue;
		}

		const lines = content.split(/\r?\n/u);
		baseFiles.push({
			contentLines: lines.map((text) => ({ text })),
			imports: [],
			language,
			lineCount: lines.length,
			path: p,
		});
	}

	if (baseFiles.length === 0) return null;

	// Discover LSP inspectors for the languages we need
	const languages = [...new Set(baseFiles.map((f) => f.language))];
	const lspRegistry = registry.filter(
		(e) => e.protocol === 'lsp' && lspEntryAllowed(e, options.lsp),
	);
	const inspectors = await discoverInspectors(languages, lspRegistry);

	if (inspectors.length === 0) return null;

	const files = [];
	const inspectorNames = [];

	for (const descriptor of inspectors) {
		const matchingFiles = baseFiles.filter((f) =>
			descriptor.languages.includes(f.language),
		);
		if (matchingFiles.length === 0) continue;

		let results;
		try {
			results = await runLspInspector(descriptor, matchingFiles, cwd, {
				diagWindow: options.lspDiagWindow ?? 1500,
				initTimeout: options.lspInitTimeout ?? 15_000,
				requestTimeout: options.lspRequestTimeout ?? 30_000,
				runBudget: options.lspRunBudget ?? 60_000,
			});
		} catch {
			// Never let a failing LSP inspector surface as an error
			continue;
		}

		inspectorNames.push(descriptor.name);
		for (const inspectedFile of results) {
			if (inspectedFile.lspDiagnostics) {
				files.push(inspectedFile);
			}
		}
	}

	// Normalize file entries: lspDiagnostics → diagnostics so that
	// renderDiagnosticsForModel can consume the report directly.
	let errorCount = 0;
	let warningCount = 0;
	const normalizedFiles = [];
	for (const file of files) {
		const diagnostics = file.lspDiagnostics || [];
		for (const diag of diagnostics) {
			if (diag.severity === 'error') errorCount++;
			else if (diag.severity === 'warning') warningCount++;
		}
		normalizedFiles.push({
			path: file.path,
			language: file.language,
			diagnostics,
		});
	}

	return {
		durationMs: Math.round(performance.now() - start),
		errorCount,
		files: normalizedFiles,
		inspectors: inspectorNames,
		skipped,
		warningCount,
	};
}

/**
 * Convenience gate: run post-write LSP diagnostics only when a write was
 * applied and LSP inspection is enabled.
 *
 * @param {string} cwd          - Workspace root (absolute path).
 * @param {object} writeResult  - { applied: boolean, writes: [{ path }] }
 * @param {object} options      - Passed through to inspectChangedFiles.
 * @param {object[]} registry   - Inspector registry (defaults to REGISTRY).
 * @returns {object|null}
 */
export async function runPostWriteDiagnostics(
	cwd,
	writeResult,
	options = {},
	registry = REGISTRY,
) {
	try {
		if (!options.lsp) return null;
		if (!writeResult?.applied) return null;
		if (!Array.isArray(writeResult.writes) || writeResult.writes.length === 0) {
			return null;
		}
		return await inspectChangedFiles(
			cwd,
			writeResult.writes.map((w) => w.path),
			options,
			registry,
		);
	} catch {
		return null;
	}
}
