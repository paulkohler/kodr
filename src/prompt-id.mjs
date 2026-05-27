import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

export function derivePromptId(text) {
	return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export function promptIdFromFilename(filePath) {
	const name = basename(filePath, extname(filePath));
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}
