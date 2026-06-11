import { spawn } from 'node:child_process';
import { inspectWorkspace, rankSymbols } from './repomap/index.mjs';

const DEFAULT_TIMEOUT = 10000;

/**
 * Registry entry shape:
 * {
 *   name: string,
 *   languages: string[],
 *   command: string,
 *   buildArgs: (files: string[], cwd: string) => string[],
 *   adapt: (stdout: string, files: string[]) => InspectedFile[],
 *   timeout: number,      // ms
 *   onFailure: 'skip' | 'throw',
 * }
 *
 * Normalized InspectedFile matches inspectFile() output:
 * { path, language, lineCount, imports, symbols }
 */

export const REGISTRY = [
	{
		adapt: adaptJsonOutput,
		buildArgs: (files) => ['--json', ...files],
		command: 'gopls',
		languages: ['go'],
		name: 'gopls',
		onFailure: 'skip',
		timeout: DEFAULT_TIMEOUT,
	},
	{
		adapt: adaptJsonOutput,
		buildArgs: (files) => ['--outputjson', ...files],
		command: 'pyright',
		languages: ['python'],
		name: 'pyright',
		onFailure: 'skip',
		timeout: DEFAULT_TIMEOUT,
	},
	{
		adapt: adaptJsonOutput,
		buildArgs: (files) => ['--json', ...files],
		command: 'rust-analyzer',
		languages: ['rust'],
		name: 'rust-analyzer',
		onFailure: 'skip',
		timeout: DEFAULT_TIMEOUT,
	},
	{
		adapt: adaptJsonOutput,
		buildArgs: (files) => ['--json', ...files],
		command: 'typescript-language-server',
		languages: ['javascript', 'typescript'],
		name: 'typescript-language-server',
		onFailure: 'skip',
		timeout: DEFAULT_TIMEOUT,
	},
];

/**
 * Check if a command is available by running it with no args and seeing if
 * it exits with something other than ENOENT.
 */
export async function checkAvailability(command, timeout = 3000) {
	return new Promise((resolve) => {
		const child = spawn(command, ['--version'], {
			stdio: ['ignore', 'ignore', 'ignore'],
		});
		const timer = setTimeout(() => {
			child.kill();
			resolve(true); // present but slow
		}, timeout);
		child.on('error', (err) => {
			clearTimeout(timer);
			resolve(err.code !== 'ENOENT');
		});
		child.on('close', () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/**
 * Run an external inspector command against a list of relative file paths.
 * Returns { stdout, stderr, exitCode }.
 */
export async function runInspectorCommand(descriptor, files, cwd) {
	const { command, buildArgs, timeout = DEFAULT_TIMEOUT } = descriptor;
	const args = buildArgs(files, cwd);

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill();
			resolve({ exitCode: null, stderr, stdout, timedOut: true });
		}, timeout);

		child.stdout.on('data', (chunk) => {
			stdout += chunk;
		});
		child.stderr.on('data', (chunk) => {
			stderr += chunk;
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			if (descriptor.onFailure === 'throw') {
				reject(err);
			} else {
				resolve({ error: err, exitCode: null, stderr, stdout });
			}
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ exitCode: code, stderr, stdout });
		});
	});
}

/**
 * Discover which registered inspectors are available for the given languages.
 * Returns the subset of REGISTRY entries whose commands are present.
 */
export async function discoverInspectors(languages, registry = REGISTRY) {
	const relevant = registry.filter((entry) =>
		entry.languages.some((lang) => languages.includes(lang)),
	);
	const checks = await Promise.all(
		relevant.map(async (entry) => ({
			available: await checkAvailability(entry.command),
			entry,
		})),
	);
	return checks.filter((c) => c.available).map((c) => c.entry);
}

/**
 * Merge external inspector results into the base index.
 * External results take precedence for files they cover; the base index fills gaps.
 */
export function mergeInspectorResults(baseIndex, externalFiles) {
	if (externalFiles.length === 0) {
		return baseIndex;
	}

	const externalByPath = new Map(externalFiles.map((f) => [f.path, f]));
	const merged = baseIndex.files.map((file) => {
		const external = externalByPath.get(file.path);
		return external ? mergeExternalFile(file, external) : file;
	});

	for (const [path, file] of externalByPath) {
		if (!merged.some((f) => f.path === path)) {
			merged.push(file);
		}
	}

	const mergedIndex = {
		...baseIndex,
		files: merged,
		symbols: merged.flatMap((file) =>
			file.symbols.map((symbol) => ({
				...symbol,
				language: file.language,
				path: file.path,
			})),
		),
	};
	return {
		...mergedIndex,
		rankedSymbols: rankSymbols(mergedIndex),
		totalFiles: merged.length,
		totalSymbols: mergedIndex.symbols.length,
	};
}

function mergeExternalFile(baseFile, externalFile) {
	return {
		...baseFile,
		...externalFile,
		contentLines: baseFile.contentLines,
	};
}

/**
 * Inspect a workspace using the external inspector registry.
 * Falls back gracefully to the built-in inspector when no external tools are
 * available or when they fail.
 */
export async function inspectWithRegistry(
	cwd,
	options = {},
	registry = REGISTRY,
) {
	const baseIndex = await inspectWorkspace(cwd, options);

	const presentLanguages = Object.keys(baseIndex.languages);
	const available = await discoverInspectors(presentLanguages, registry);

	if (available.length === 0) {
		return { ...baseIndex, externalInspectors: [] };
	}

	const externalFiles = [];
	const usedInspectors = [];

	for (const inspector of available) {
		const files = baseIndex.files
			.filter((f) => inspector.languages.includes(f.language))
			.map((f) => f.path);

		if (files.length === 0) {
			continue;
		}

		try {
			const result = await runInspectorCommand(inspector, files, cwd);
			if (result.timedOut || result.error || result.exitCode !== 0) {
				continue;
			}
			const adapted = inspector.adapt(result.stdout, files);
			externalFiles.push(...adapted);
			usedInspectors.push(inspector.name);
		} catch {
			if (inspector.onFailure === 'throw') {
				throw new Error(`Inspector ${inspector.name} failed`);
			}
		}
	}

	const merged = mergeInspectorResults(baseIndex, externalFiles);
	return {
		...merged,
		externalInspectors: usedInspectors,
		rankedSymbols: rankSymbols(merged, {
			query: options.query || options.symbol || '',
		}),
	};
}

/**
 * Default adapter for inspectors that emit JSON matching the normalized shape.
 * Expected output: { files: [{ path, language, lineCount, imports, symbols }] }
 */
export function adaptJsonOutput(stdout) {
	try {
		const parsed = JSON.parse(stdout);
		if (Array.isArray(parsed.files)) {
			return parsed.files;
		}
		if (Array.isArray(parsed)) {
			return parsed;
		}
	} catch {
		// malformed output — return empty
	}
	return [];
}
