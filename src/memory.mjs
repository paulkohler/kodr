import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PROJECT_MEMORY_PATH = 'KODR_MEMORY.md';
export const USER_MEMORY_PATH = '.kodr/memory/user.md';

const DEFAULT_MEMORY_BYTES = 12000;

export async function loadMemory(cwd, options = {}) {
	const maxBytes = options.maxBytes || DEFAULT_MEMORY_BYTES;

	return {
		project: await readMemoryFile(cwd, PROJECT_MEMORY_PATH, maxBytes),
		user: await readMemoryFile(cwd, USER_MEMORY_PATH, maxBytes),
	};
}

function readMemoryFile(cwd, path, maxBytes) {
	return readFile(join(cwd, path))
		.then((buffer) => {
			const content = buffer.subarray(0, maxBytes).toString('utf8');
			return {
				content,
				includedBytes: Buffer.byteLength(content),
				path,
				truncated: buffer.length > maxBytes,
			};
		})
		.catch((error) => {
			if (error.code === 'ENOENT') {
				return null;
			}
			throw error;
		});
}
