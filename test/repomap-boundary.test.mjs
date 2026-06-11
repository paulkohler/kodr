import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const REPOMAP_DIR = new URL('../src/repomap/', import.meta.url).pathname;
const SRC_DIR = new URL('../src/', import.meta.url).pathname;

async function listMjs(dir) {
	const entries = await readdir(dir);
	return entries.filter((name) => name.endsWith('.mjs'));
}

function importSpecifiers(source) {
	const specifiers = [];
	for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
		specifiers.push(match[1]);
	}
	return specifiers;
}

describe('repomap boundary', () => {
	it('repomap files only import node builtins or sibling repomap files', async () => {
		const files = await listMjs(REPOMAP_DIR);
		const violations = [];

		for (const file of files) {
			const source = await readFile(`${REPOMAP_DIR}${file}`, 'utf8');
			for (const specifier of importSpecifiers(source)) {
				const isNodeBuiltin = specifier.startsWith('node:');
				const isSibling = /^\.\/[^/]+$/u.test(specifier);
				if (!isNodeBuiltin && !isSibling) {
					violations.push(`${file}: ${specifier}`);
				}
			}
		}

		assert.deepEqual(
			violations,
			[],
			`repomap files must only import node: builtins or sibling files: ${violations.join(', ')}`,
		);
	});

	it('app src files only import repomap through the entry point', async () => {
		const appFiles = await listMjs(SRC_DIR);
		const violations = [];

		for (const file of appFiles) {
			const source = await readFile(`${SRC_DIR}${file}`, 'utf8');
			for (const specifier of importSpecifiers(source)) {
				if (
					specifier.includes('repomap/') &&
					!specifier.endsWith('repomap/index.mjs')
				) {
					violations.push(`${file}: ${specifier}`);
				}
			}
		}

		assert.deepEqual(
			violations,
			[],
			`app files must import from repomap/index.mjs only: ${violations.join(', ')}`,
		);
	});
});
