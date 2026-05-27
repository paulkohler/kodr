import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function installLocal(cwd, options = {}) {
	const dir = options.dir || `${process.env.HOME}/.local/bin`;
	const name = options.name || 'kodr';
	const target = join(dir, name);
	const entry = resolve(cwd, 'bin', 'kodr.mjs');
	const shim = `#!/bin/sh
exec node "${entry}" "$@"
`;

	await mkdir(dir, { recursive: true });
	await writeFile(target, shim, 'utf8');
	await chmod(target, 0o755);

	return {
		path: target,
	};
}
