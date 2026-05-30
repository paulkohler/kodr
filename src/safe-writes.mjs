import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	realpath,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';

export class SafeWriteError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SafeWriteError';
	}
}

export async function prepareChanges(cwd, proposal, options = {}) {
	const files = proposal.files || [];
	const patches = proposal.patches || [];
	const apply = options.apply === true;
	const timestamp =
		options.timestamp || new Date().toISOString().replaceAll(':', '-');

	if (options.protectExisting) {
		for (const file of files) {
			if (await isGitTracked(cwd, file.path)) {
				throw new SafeWriteError(
					`Refusing to overwrite git-tracked file via files[]: ${file.path} — use patches instead`,
				);
			}
		}
	}

	const fileResult = await prepareWrites(cwd, files, {
		apply,
		timestamp,
	});
	const patchResult = await preparePatches(cwd, patches, {
		apply,
		timestamp,
	});

	return {
		applied: apply,
		writes: [...fileResult.writes, ...patchResult.writes],
	};
}

export async function prepareWrites(cwd, files, options = {}) {
	const apply = options.apply === true;
	const timestamp =
		options.timestamp || new Date().toISOString().replaceAll(':', '-');
	const writes = [];

	for (const file of files) {
		const jailed = await jailedPath(cwd, file.path);
		const before = await readExisting(jailed.absolute);
		const diff = makeDiff(file.path, before, file.content);
		const backupPath =
			before.exists && apply
				? join(cwd, '.kodr', 'backups', timestamp, file.path)
				: '';

		writes.push({
			backupPath,
			diff,
			path: file.path,
			status: before.exists ? 'modify' : 'create',
		});

		if (apply) {
			await mkdir(dirname(jailed.absolute), { recursive: true });
			if (before.exists) {
				await mkdir(dirname(backupPath), { recursive: true });
				await copyFile(jailed.absolute, backupPath);
			}
			await writeFile(jailed.absolute, file.content, 'utf8');
		}
	}

	return {
		applied: apply,
		writes,
	};
}

export async function preparePatches(cwd, patches, options = {}) {
	const apply = options.apply === true;
	const timestamp =
		options.timestamp || new Date().toISOString().replaceAll(':', '-');
	const writes = [];
	const targets = new Map();

	for (const patch of patches) {
		const jailed = await jailedPath(cwd, patch.path);
		let target = targets.get(patch.path);
		if (!target) {
			const before = await readExisting(jailed.absolute);
			if (!before.exists) {
				throw new SafeWriteError(`Patch target does not exist: ${patch.path}`);
			}
			target = {
				absolute: jailed.absolute,
				backupPath: apply
					? join(cwd, '.kodr', 'backups', timestamp, patch.path)
					: '',
				content: before.content,
				original: before.content,
			};
			targets.set(patch.path, target);
		}

		if (target.content === null) {
			throw new SafeWriteError(`Patch target does not exist: ${patch.path}`);
		}

		const normalized = normalizePatch(target.content, patch);
		const occurrences = countOccurrences(target.content, normalized.search);
		if (occurrences !== 1) {
			throw new SafeWriteError(
				`Patch search must match exactly once in ${patch.path}; found ${occurrences}`,
			);
		}

		const after = target.content.replace(normalized.search, normalized.replace);

		writes.push({
			backupPath: target.backupPath,
			diff: makeDiff(
				patch.path,
				{
					content: target.content,
					exists: true,
				},
				after,
			),
			path: patch.path,
			status: 'patch',
		});

		target.content = after;
	}

	if (apply) {
		for (const item of targets.values()) {
			await mkdir(dirname(item.absolute), { recursive: true });
			await mkdir(dirname(item.backupPath), { recursive: true });
			await copyFile(item.absolute, item.backupPath);
			await writeFile(item.absolute, item.content, 'utf8');
		}
	}

	return {
		applied: apply,
		writes,
	};
}

export async function jailedPath(cwd, path) {
	validateRelativePath(path);
	await rejectSymlinkParents(cwd, path);

	const absolute = join(cwd, path);
	const root = await realpath(cwd);
	const parent = await realpathExistingParent(cwd, path);
	const parentRelative = relative(root, parent);

	if (parentRelative.startsWith('..') || isAbsolute(parentRelative)) {
		throw new SafeWriteError(`Path escapes workspace: ${path}`);
	}

	await rejectEscapingExistingTarget(root, absolute, path);

	return {
		absolute,
		path,
	};
}

function validateRelativePath(path) {
	if (!path || typeof path !== 'string') {
		throw new SafeWriteError('Write path must be a non-empty string');
	}

	if (isAbsolute(path)) {
		throw new SafeWriteError(`Absolute paths are not allowed: ${path}`);
	}

	const parts = path.split(/[\\/]+/u);
	if (parts.includes('..')) {
		throw new SafeWriteError(`Parent path segments are not allowed: ${path}`);
	}
}

async function rejectSymlinkParents(cwd, path) {
	const parts = path.split(/[\\/]+/u).slice(0, -1);
	let current = cwd;

	for (const part of parts) {
		current = join(current, part);
		try {
			const stat = await lstat(current);
			if (stat.isSymbolicLink()) {
				throw new SafeWriteError(`Symlink parent is not allowed: ${path}`);
			}
		} catch (error) {
			if (error.code === 'ENOENT') {
				return;
			}
			throw error;
		}
	}
}

async function rejectEscapingExistingTarget(root, absolute, path) {
	try {
		const stat = await lstat(absolute);
		if (stat.isSymbolicLink()) {
			throw new SafeWriteError(`Symlink target is not allowed: ${path}`);
		}
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}

	const target = await realpath(absolute);
	const targetRelative = relative(root, target);
	if (targetRelative.startsWith('..') || isAbsolute(targetRelative)) {
		throw new SafeWriteError(`Path escapes workspace: ${path}`);
	}
}

async function realpathExistingParent(cwd, path) {
	let parent = dirname(join(cwd, path));

	while (parent.startsWith(cwd)) {
		try {
			return await realpath(parent);
		} catch (error) {
			if (error.code !== 'ENOENT') {
				throw error;
			}
			parent = dirname(parent);
		}
	}

	return realpath(cwd);
}

async function readExisting(path) {
	try {
		return {
			content: await readFile(path, 'utf8'),
			exists: true,
		};
	} catch (error) {
		if (error.code === 'ENOENT') {
			return {
				content: '',
				exists: false,
			};
		}
		throw error;
	}
}

// Number of unchanged context lines kept around each change in a hunk.
const DIFF_CONTEXT = 3;
// Above this many lines on either side we skip the O(m*n) LCS table and fall
// back to the whole-file dump. Keeps memory bounded on very large files; for the
// small apps kodr generates the LCS path always wins.
const DIFF_MAX_LINES = 2000;

export function makeDiff(path, before, after) {
	const beforeLines = before.exists ? before.content.split('\n') : [];
	const afterLines = after.split('\n');
	const header = `--- ${path}\n+++ ${path}\n`;

	if (
		beforeLines.length > DIFF_MAX_LINES ||
		afterLines.length > DIFF_MAX_LINES
	) {
		return header + wholeFileDump(beforeLines, afterLines);
	}

	const ops = diffLines(beforeLines, afterLines);
	const hunks = buildHunks(ops);
	if (hunks.length === 0) {
		return header;
	}

	return header + hunks.map(renderHunk).join('');
}

// Fallback used for files past the size bound: every old line as `-`, every new
// line as `+`. This is the original pre-phase-40 diff shape.
function wholeFileDump(beforeLines, afterLines) {
	const lines = [];
	for (const line of beforeLines) {
		lines.push(`-${line}`);
	}
	for (const line of afterLines) {
		lines.push(`+${line}`);
	}
	return `${lines.join('\n')}\n`;
}

// Longest-common-subsequence line diff. Returns an op stream of
// { type: 'eq' | 'del' | 'ins', line } annotated with 1-based old/new line
// numbers as they stood before the op was applied.
function diffLines(a, b) {
	const m = a.length;
	const n = b.length;
	const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

	for (let i = m - 1; i >= 0; i -= 1) {
		for (let j = n - 1; j >= 0; j -= 1) {
			dp[i][j] =
				a[i] === b[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const ops = [];
	let i = 0;
	let j = 0;
	let oldLine = 1;
	let newLine = 1;

	const push = (type, line) => {
		ops.push({ type, line, oldLine, newLine });
		if (type !== 'ins') {
			oldLine += 1;
		}
		if (type !== 'del') {
			newLine += 1;
		}
	};

	while (i < m && j < n) {
		if (a[i] === b[j]) {
			push('eq', a[i]);
			i += 1;
			j += 1;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			push('del', a[i]);
			i += 1;
		} else {
			push('ins', b[j]);
			j += 1;
		}
	}
	while (i < m) {
		push('del', a[i]);
		i += 1;
	}
	while (j < n) {
		push('ins', b[j]);
		j += 1;
	}

	return ops;
}

// Group the op stream into hunks: clusters of changes that are within
// 2*DIFF_CONTEXT equal lines of each other, padded by up to DIFF_CONTEXT lines
// of context on each side.
function buildHunks(ops) {
	const changed = [];
	for (let index = 0; index < ops.length; index += 1) {
		if (ops[index].type !== 'eq') {
			changed.push(index);
		}
	}
	if (changed.length === 0) {
		return [];
	}

	const hunks = [];
	let start = changed[0];
	let end = changed[0];

	for (let k = 1; k < changed.length; k += 1) {
		const index = changed[k];
		// Merge into the current hunk when the equal-line gap is small enough that
		// the context windows would touch; otherwise close the hunk.
		if (index - end <= 2 * DIFF_CONTEXT + 1) {
			end = index;
			continue;
		}
		hunks.push(makeHunk(ops, start, end));
		start = index;
		end = index;
	}
	hunks.push(makeHunk(ops, start, end));

	return hunks;
}

function makeHunk(ops, firstChange, lastChange) {
	const lo = Math.max(0, firstChange - DIFF_CONTEXT);
	const hi = Math.min(ops.length - 1, lastChange + DIFF_CONTEXT);
	const slice = ops.slice(lo, hi + 1);

	let oldCount = 0;
	let newCount = 0;
	for (const op of slice) {
		if (op.type !== 'ins') {
			oldCount += 1;
		}
		if (op.type !== 'del') {
			newCount += 1;
		}
	}

	const first = slice[0];
	return {
		oldStart: oldCount === 0 ? 0 : first.oldLine,
		oldCount,
		newStart: newCount === 0 ? 0 : first.newLine,
		newCount,
		ops: slice,
	};
}

function renderHunk(hunk) {
	const lines = [
		`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`,
	];
	for (const op of hunk.ops) {
		const prefix = op.type === 'del' ? '-' : op.type === 'ins' ? '+' : ' ';
		lines.push(`${prefix}${op.line}`);
	}
	return `${lines.join('\n')}\n`;
}

function countOccurrences(value, search) {
	if (search === '') {
		return 0;
	}

	let count = 0;
	let offset = 0;
	while (true) {
		const index = value.indexOf(search, offset);
		if (index === -1) {
			return count;
		}
		count += 1;
		offset = index + search.length;
	}
}

function normalizePatch(content, patch) {
	if (countOccurrences(content, patch.search) !== 0) {
		return patch;
	}

	const search = unescapePatchString(patch.search);
	if (search !== patch.search && countOccurrences(content, search) === 1) {
		return {
			...patch,
			replace: unescapePatchString(patch.replace),
			search,
		};
	}

	if (search === patch.search || countOccurrences(content, search) !== 1) {
		const fuzzySearch = findWhitespaceTolerantSearch(content, search);
		if (!fuzzySearch) {
			return patch;
		}

		return {
			...patch,
			replace: unescapePatchString(patch.replace),
			search: fuzzySearch,
		};
	}

	return {
		...patch,
		replace: unescapePatchString(patch.replace),
		search,
	};
}

function findWhitespaceTolerantSearch(content, search) {
	const searchLines = splitLines(search);
	if (searchLines.length === 0 || searchLines.length > 20) {
		return '';
	}

	const normalizedSearch = normalizeHorizontalWhitespace(search);
	const contentLines = splitLines(content);
	const matches = [];

	for (
		let index = 0;
		index <= contentLines.length - searchLines.length;
		index += 1
	) {
		const candidate = contentLines
			.slice(index, index + searchLines.length)
			.join('');
		if (normalizeHorizontalWhitespace(candidate) === normalizedSearch) {
			matches.push(candidate);
		}
	}

	return matches.length === 1 ? matches[0] : '';
}

function splitLines(value) {
	const lines = value.match(/.*(?:\n|$)/gu) || [];
	return lines.filter((line) => line !== '');
}

function normalizeHorizontalWhitespace(value) {
	return value
		.split('\n')
		.map((line) => line.replaceAll(/[ \t]+/gu, ''))
		.join('\n')
		.replaceAll(/\n+$/gu, '');
}

function unescapePatchString(value) {
	return value
		.replaceAll('\\n', '\n')
		.replaceAll('\\t', '\t')
		.replaceAll('\\"', '"')
		.replaceAll('\\\\', '\\');
}

async function isGitTracked(cwd, filePath) {
	return new Promise((resolve) => {
		execFile('git', ['ls-files', '--error-unmatch', filePath], { cwd }, (err) =>
			resolve(err === null),
		);
	});
}
