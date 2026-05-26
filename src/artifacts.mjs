import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export async function createRunArtifacts(cwd, out = '') {
	const runDir = out
		? outputPath(cwd, out)
		: join(cwd, '.koder', 'runs', timestamp());
	await mkdir(runDir, { recursive: true });
	return runDir;
}

export async function writeJson(path, value) {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(path, value) {
	await writeFile(path, value, 'utf8');
}

function outputPath(cwd, out) {
	return isAbsolute(out) ? out : join(cwd, out);
}

function timestamp() {
	return new Date().toISOString().replaceAll(':', '-');
}
