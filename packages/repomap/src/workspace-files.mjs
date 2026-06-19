import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, sep } from 'node:path';

const DEFAULT_IGNORES = new Set([
	'.git',
	'.kodr',
	'node_modules',
	'dist',
	'build',
	'coverage',
]);

/**
 * Walk a workspace and return relative paths of all non-binary files.
 *
 * Options:
 *   ignore         – string[] of exact directory/file names to skip
 *   ignorePatterns – RegExp[] tested against each entry name
 */
export async function listContextFiles(cwd, options = {}) {
	const files = [];
	const shouldIgnore = buildIgnorePredicate(options);
	await walk(cwd, cwd, files, shouldIgnore);
	return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Read up to maxBytes of a text file. Returns null for binary files or
 * files that cannot be read.
 */
export async function readTextPrefix(path, maxBytes) {
	const buffer = await readFile(path);
	const prefix = buffer.subarray(0, maxBytes);
	if (looksBinary(prefix)) {
		return null;
	}
	return prefix.toString('utf8');
}

/**
 * Return true when the buffer looks like binary data (null bytes or a high
 * ratio of non-printable bytes).
 */
export function looksBinary(buffer) {
	if (buffer.length === 0) {
		return false;
	}
	let suspicious = 0;
	for (const byte of buffer) {
		if (byte === 0) {
			return true;
		}
		if (byte < 7 || (byte > 13 && byte < 32)) {
			suspicious += 1;
		}
	}
	return suspicious / buffer.length > 0.1;
}

function buildIgnorePredicate(options) {
	const extra = new Set(options.ignore || []);
	const patterns = options.ignorePatterns || [];
	return (name) => {
		if (DEFAULT_IGNORES.has(name) || extra.has(name)) {
			return true;
		}
		return patterns.some((pattern) => pattern.test(name));
	};
}

async function walk(root, dir, files, shouldIgnore) {
	const entries = await readdir(dir, { withFileTypes: true });
	const sorted = entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	);
	for (const entry of sorted) {
		if (shouldIgnore(entry.name)) {
			continue;
		}
		const path = `${dir}/${entry.name}`;
		const relativePath = relative(root, path).split(sep).join('/');
		if (entry.isDirectory()) {
			await walk(root, path, files, shouldIgnore);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const stat = await lstat(path);
		if (stat.isSymbolicLink()) {
			continue;
		}
		files.push(relativePath);
	}
}
