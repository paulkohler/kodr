#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { roadmapVersion } from '../src/version.mjs';

const root = process.cwd();
const expected = roadmapVersion(root);
const packageJson = JSON.parse(
	await readFile(join(root, 'package.json'), 'utf8'),
);

if (process.argv.includes('--check')) {
	if (packageJson.version !== expected) {
		console.error(
			`package.json version ${packageJson.version} does not match roadmap version ${expected}`,
		);
		process.exitCode = 1;
	}
} else {
	process.stdout.write(`${expected}\n`);
}
