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
				? join(cwd, '.koder', 'backups', timestamp, file.path)
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
