import {
	copyFile,
	lstat,
	mkdir,
	readFile,
	realpath,
	writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

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

function makeDiff(path, before, after) {
	const beforeLines = before.exists ? before.content.split('\n') : [];
	const afterLines = after.split('\n');
	const lines = [`--- ${path}`, `+++ ${path}`];

	for (const line of beforeLines) {
		lines.push(`-${line}`);
	}

	for (const line of afterLines) {
		lines.push(`+${line}`);
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
