import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// Phase 149 guard: a bare `kodr run`/`chat`/`tui` must not statically import the
// heavy Tier-4 capabilities (orchestration, sandboxes, LSP, MCP, the web server).
// Each is reached only via a dynamic import() behind the flag/command that needs
// it. This test traverses the STATIC import graph from src/app.mjs (parsing only
// `import …/export … from '…'` statements, ignoring dynamic import()) and asserts
// the heavy modules are absent. If a future static import drags one back onto the
// bare-run path, this fails loudly — the import-graph analogue of the phase-148
// export-surface guard.

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, '..', 'src');

// Matches only static `import`/`export` statements that carry a `from '…'`
// clause (so dynamic `await import('…')` — which has no `from` — is ignored).
const STATIC_RE = /^\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/gm;

async function staticDeps(file) {
	let source;
	try {
		source = await readFile(file, 'utf8');
	} catch {
		return [];
	}
	const deps = [];
	for (const match of source.matchAll(STATIC_RE)) {
		const spec = match[1];
		if (!spec.startsWith('.')) continue; // skip node:/package specifiers
		deps.push(resolve(dirname(file), spec));
	}
	return deps;
}

async function reachableFrom(entry) {
	const seen = new Set();
	const stack = [resolve(entry)];
	while (stack.length > 0) {
		const file = stack.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		for (const dep of await staticDeps(file)) stack.push(dep);
	}
	return seen;
}

function isReachable(graph, moduleName) {
	const target = resolve(SRC, moduleName);
	return graph.has(target);
}

describe('lazy-load guard: bare-run static import graph (phase 149)', () => {
	// Modules that must NOT be statically reachable from app.mjs.
	const forbidden = [
		'orchestration.mjs',
		'subagents.mjs',
		'docker-executor.mjs',
		'openshell-executor.mjs',
		'openshell-worker.mjs',
		'external-inspector-registry.mjs',
		'lsp-client.mjs',
		'mcp-client.mjs',
		'server.mjs',
		'watcher.mjs',
	];

	// Core modules that MUST stay on the static path (sanity: the guard is not
	// trivially passing because the graph is broken/empty).
	const required = [
		'run-pipeline.mjs',
		'model-client.mjs',
		'tools.mjs',
		'context-packer.mjs',
		'cli/args.mjs',
	];

	for (const moduleName of forbidden) {
		it(`does not statically import ${moduleName} on a bare run`, async () => {
			const graph = await reachableFrom(resolve(SRC, 'app.mjs'));
			assert.equal(
				isReachable(graph, moduleName),
				false,
				`${moduleName} must be lazy-loaded (dynamic import), not statically reachable from app.mjs`,
			);
		});
	}

	for (const moduleName of required) {
		it(`still statically imports core module ${moduleName}`, async () => {
			const graph = await reachableFrom(resolve(SRC, 'app.mjs'));
			assert.equal(
				isReachable(graph, moduleName),
				true,
				`${moduleName} is core and should remain on the static path`,
			);
		});
	}

	it('the bare-run graph stays well under the pre-phase-149 size (84)', async () => {
		const graph = await reachableFrom(resolve(SRC, 'app.mjs'));
		// Was 84 before phase 149; ~59 after. Allow headroom for new core
		// modules but fail if a large chunk of Tier-4 creeps back statically.
		const srcModules = [...graph].filter((f) =>
			relative(SRC, f).match(/^[^.].*\.mjs$/u),
		);
		assert.ok(
			srcModules.length <= 70,
			`bare-run static graph grew to ${srcModules.length} modules (was ~59); a Tier-4 module may have been re-imported statically`,
		);
	});
});
