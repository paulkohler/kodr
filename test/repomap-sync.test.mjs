import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Phase 154: `packages/repomap/src/` is a manual copy of the canonical
// `src/repomap/` tree (the app imports `./repomap/index.mjs`; the package tree
// exists only to publish @kodr/repomap). Nothing else keeps them in sync, so a
// fix landed in one tree and not the other would silently ship stale code in the
// package. This guard fails the moment the two `.mjs` trees diverge.
//
// Scope: `.mjs` source only. README.md / LICENSE / package.json are intentionally
// tree-specific (the package carries its own) and are not compared.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const canonicalDir = join(repoRoot, 'src', 'repomap');
const mirrorDir = join(repoRoot, 'packages', 'repomap', 'src');

const mjsFiles = (dir) =>
	readdirSync(dir)
		.filter((f) => f.endsWith('.mjs'))
		.sort();

describe('@kodr/repomap tree sync', () => {
	it('the two trees expose the same set of .mjs files', () => {
		const canonical = mjsFiles(canonicalDir);
		const mirror = mjsFiles(mirrorDir);
		const onlyCanonical = canonical.filter((f) => !mirror.includes(f));
		const onlyMirror = mirror.filter((f) => !canonical.includes(f));
		assert.deepEqual(
			onlyMirror,
			[],
			`packages/repomap/src has stale module(s) with no src/repomap source: ${onlyMirror.join(', ')} — delete them or add the source`,
		);
		assert.deepEqual(
			onlyCanonical,
			[],
			`src/repomap module(s) not copied to packages/repomap/src: ${onlyCanonical.join(', ')} — copy them into the package tree`,
		);
	});

	for (const file of mjsFiles(canonicalDir)) {
		it(`packages/repomap/src/${file} is byte-identical to src/repomap/${file}`, () => {
			const canonical = readFileSync(join(canonicalDir, file), 'utf8');
			const mirror = readFileSync(join(mirrorDir, file), 'utf8');
			assert.equal(
				mirror,
				canonical,
				`packages/repomap/src/${file} has drifted from src/repomap/${file} — copy src/repomap/${file} to packages/repomap/src/${file}`,
			);
		});
	}
});
