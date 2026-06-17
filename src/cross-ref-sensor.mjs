// cross-ref-sensor.mjs — deterministic cross-reference sensors.
//
// These sensors check structural consistency between generated files that the
// advisory reviewer keeps missing. They are model-free and fast, running
// synchronously on the written file tree.
//
// Phase 158: Compose ↔ Dockerfile sensor.
//   Flags `build:` entries in docker-compose files that have no Dockerfile at
//   the referenced context path. A compose file that references a build context
//   with no Dockerfile will fail `docker compose up --build`.
//
// Phase 159: CSS selector ↔ HTML sensor.
//   Flags CSS id/class selectors that match no element in any linked HTML file.
//   Catches the "styled but absent" class of defect that is invisible to the
//   reviewer but causes silently inert styling.
//
// Phase 167: Local import-path existence sensor.
//   Flags relative `import`/`export from` specifiers in JS files that point to
//   a path which does not exist on disk. Catches the common case where the model
//   writes a file that imports from a peer it forgot to create.
//
// Phase 172: Import cycle detection sensor.
//   Builds a dependency graph from the write set and runs DFS to find circular
//   import chains (A → B → A). Cycles don't crash Node.js but can produce
//   `undefined` exports at runtime and are hard to diagnose.
//
// Phase 173: Secret-in-response sensor.
//   Heuristic: flags JS code where a variable or property named
//   password/hash/secret/token/credential appears to be serialised or returned
//   to callers (res.json, JSON.stringify, jwt.sign, return {…}). Advisory only.
//
// Design:
// - Run only when a write was applied and the sensor's file type was written.
// - Return { sensor, status, checked, issues, message }.
//   status: 'ok' | 'warn' | 'skipped'
//   'warn' = issues found (advisory, not a hard failure).
//   'skipped' = no relevant files in write set; sensor did not run.
// - Zero runtime dependencies; Node.js 24 built-ins only.

import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
	basename,
	dirname,
	extname,
	join,
	normalize,
	posix,
	relative,
} from 'node:path';

// ---------------------------------------------------------------------------
// Canonical sensor name registry (Phase 180)
// ---------------------------------------------------------------------------

export const SENSOR_NAMES = {
	COMPOSE_DOCKERFILE: 'compose-dockerfile',
	CSS_SELECTOR: 'css-selector',
	LOCAL_IMPORT: 'local-import',
	IMPORT_CYCLES: 'import-cycles',
	SECRET_IN_RESPONSE: 'secret-in-response',
	SECRETS_AT_REST: 'secrets-at-rest',
};

// Phase 188: per-sensor default severity.
// 'error'   — runtime-breaking or security-critical; promoted to failure by --strict.
// 'warning' — advisory; informational even in --strict mode.
export const SENSOR_SEVERITY = {
	[SENSOR_NAMES.COMPOSE_DOCKERFILE]: 'warning',
	[SENSOR_NAMES.CSS_SELECTOR]: 'warning',
	[SENSOR_NAMES.LOCAL_IMPORT]: 'error',
	[SENSOR_NAMES.IMPORT_CYCLES]: 'error',
	[SENSOR_NAMES.SECRET_IN_RESPONSE]: 'error',
	[SENSOR_NAMES.SECRETS_AT_REST]: 'error',
};

// ---------------------------------------------------------------------------
// Compose ↔ Dockerfile sensor (Phase 158)
// ---------------------------------------------------------------------------

const COMPOSE_FILENAMES = new Set([
	'docker-compose.yml',
	'docker-compose.yaml',
	'compose.yml',
	'compose.yaml',
]);

/**
 * Extract build contexts from the text of a docker-compose file.
 * Handles both inline (`build: .`) and block form (`build:\n  context: ./x`).
 * Returns [{ context, dockerfile, serviceLine }].
 *
 * This uses a line-by-line heuristic rather than a proper YAML parser (no
 * runtime dependencies). It handles all common patterns the model produces.
 *
 * @param {string} content  Raw text of a docker-compose file.
 * @returns {Array<{context: string, dockerfile: string, serviceLine: number}>}
 */
export function extractBuildContexts(content) {
	const lines = content.split('\n');
	const results = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Inline form: "  build: ." or "  build: ./api"
		const inline = /^(\s+)build:\s+(\S+)\s*$/u.exec(line);
		if (inline) {
			results.push({
				context: inline[2].replace(/^['"]|['"]$/gu, ''),
				dockerfile: 'Dockerfile',
				serviceLine: i,
			});
			continue;
		}

		// Block form: "  build:" followed by indented "context:" / "dockerfile:"
		if (/^(\s+)build:\s*$/u.test(line)) {
			const buildIndent = line.match(/^(\s+)/u)?.[1]?.length ?? 0;
			let context = '.';
			let dockerfile = 'Dockerfile';
			for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
				const inner = lines[j];
				if (!inner.trim()) continue;
				const innerIndent = inner.match(/^(\s+)/u)?.[1]?.length ?? 0;
				if (innerIndent <= buildIndent) break;
				const ctx = /^\s+context:\s+(\S+)\s*$/u.exec(inner);
				if (ctx) {
					context = ctx[1].replace(/^['"]|['"]$/gu, '');
					continue;
				}
				const df = /^\s+dockerfile:\s+(\S+)\s*$/u.exec(inner);
				if (df) {
					dockerfile = df[1].replace(/^['"]|['"]$/gu, '');
				}
			}
			results.push({ context, dockerfile, serviceLine: i });
		}
	}
	return results;
}

/**
 * Run the Compose ↔ Dockerfile sensor on one compose file.
 * Checks whether each `build:` context has a Dockerfile at the expected path.
 *
 * @param {string} cwd          Workspace root (absolute path).
 * @param {string} composePath  Workspace-relative path to the compose file.
 * @returns {Promise<Array<{type: string, composePath: string, buildContext: string, expectedDockerfile: string}>>}
 */
export async function checkComposeDockerfile(cwd, composePath) {
	let content;
	try {
		content = await readFile(join(cwd, composePath), 'utf8');
	} catch {
		return [];
	}

	const composeDir = dirname(composePath);
	const buildContexts = extractBuildContexts(content);
	const issues = [];

	for (const { context, dockerfile } of buildContexts) {
		// Resolve the Dockerfile path relative to the compose file's directory,
		// then relative to the workspace root.
		const contextDir = join(composeDir, context);
		const dockerfilePath = join(contextDir, dockerfile);
		// Safety: reject traversal outside workspace
		const normalized = normalize(dockerfilePath);
		if (normalized.startsWith('..') || posix.isAbsolute(dockerfilePath)) {
			continue;
		}
		try {
			await access(join(cwd, normalized));
			// Dockerfile exists — ok
		} catch {
			issues.push({
				buildContext: context,
				composePath,
				expectedDockerfile: normalized,
				type: 'missing-dockerfile',
			});
		}
	}
	return issues;
}

/**
 * Run the Compose ↔ Dockerfile sensor across all written files.
 * Only runs when at least one compose file is in the write set.
 *
 * @param {string} cwd          Workspace root (absolute path).
 * @param {string[]} writePaths Workspace-relative written file paths.
 * @returns {Promise<{sensor: string, status: 'ok'|'warn'|'skipped', checked: number, issues: object[], message: string}>}
 */
export async function runComposeDockerfileSensor(cwd, writePaths) {
	const composePaths = writePaths.filter((p) =>
		COMPOSE_FILENAMES.has(basename(p)),
	);
	if (composePaths.length === 0) {
		return {
			sensor: SENSOR_NAMES.COMPOSE_DOCKERFILE,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no compose files in write set',
		};
	}

	const allIssues = [];
	for (const composePath of composePaths) {
		const issues = await checkComposeDockerfile(cwd, composePath);
		allIssues.push(...issues);
	}

	if (allIssues.length === 0) {
		return {
			checked: composePaths.length,
			issues: [],
			message: `${composePaths.length} compose file${composePaths.length !== 1 ? 's' : ''} ok`,
			sensor: SENSOR_NAMES.COMPOSE_DOCKERFILE,
			status: 'ok',
		};
	}

	const detail = allIssues
		.map(
			(i) =>
				`${i.composePath}: build context '${i.buildContext}' has no ${i.expectedDockerfile}`,
		)
		.join('; ');
	return {
		checked: composePaths.length,
		issues: allIssues,
		message: detail,
		sensor: SENSOR_NAMES.COMPOSE_DOCKERFILE,
		severity: SENSOR_SEVERITY[SENSOR_NAMES.COMPOSE_DOCKERFILE],
		status: 'warn',
	};
}

// ---------------------------------------------------------------------------
// CSS selector ↔ HTML sensor (Phase 159)
// ---------------------------------------------------------------------------

const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const CSS_EXTENSIONS = new Set(['.css']);

/**
 * Extract all id and class selectors from CSS text.
 * Returns { ids: Set<string>, classes: Set<string> }.
 * Only captures plain `#foo` / `.foo` selectors, not attribute selectors or
 * pseudo-selectors — we only care about id= and class= cross-references.
 *
 * @param {string} css
 * @returns {{ ids: Set<string>, classes: Set<string> }}
 */
export function extractCssSelectors(css) {
	const ids = new Set();
	const classes = new Set();

	// Strip comments first so we don't pick up selectors inside /* */
	const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '');

	// Match selector lists before '{'. Walk the result tokens.
	for (const ruleBlock of stripped.split('{')) {
		const selectorStr = ruleBlock.split('}').at(-1) ?? ruleBlock;
		// Split on comma for selector lists
		for (const selector of selectorStr.split(',')) {
			// Find all #id tokens
			for (const m of selector.matchAll(/#([\w-]+)/gu)) {
				ids.add(m[1]);
			}
			// Find all .class tokens (exclude pseudo-class dots like `.5em`)
			for (const m of selector.matchAll(/\.([\w-]+)/gu)) {
				// Skip pure-number class names (CSS units, not class selectors)
				if (!/^\d/u.test(m[1])) {
					classes.add(m[1]);
				}
			}
		}
	}
	return { classes, ids };
}

/**
 * Extract all id and class attribute values from HTML text.
 * Returns { ids: Set<string>, classes: Set<string> }.
 *
 * @param {string} html
 * @returns {{ ids: Set<string>, classes: Set<string> }}
 */
export function extractHtmlAttributes(html) {
	const ids = new Set();
	const classes = new Set();

	for (const m of html.matchAll(/\bid=["']([^"']+)["']/giu)) {
		ids.add(m[1]);
	}
	for (const m of html.matchAll(/\bclass=["']([^"']+)["']/giu)) {
		for (const cls of m[1].split(/\s+/u)) {
			if (cls) classes.add(cls);
		}
	}
	return { classes, ids };
}

/**
 * Find CSS files linked from an HTML file via `<link rel="stylesheet" href="...">`.
 * Returns workspace-relative paths; filters to paths that are safe relative paths.
 *
 * @param {string} htmlContent
 * @param {string} htmlPath  Workspace-relative path of the HTML file.
 * @returns {string[]}
 */
export function extractLinkedCssPaths(htmlContent, htmlPath) {
	const htmlDir = dirname(htmlPath);
	const results = [];
	for (const m of htmlContent.matchAll(
		/<link[^>]+href=["']([^"']+\.css)["'][^>]*>/giu,
	)) {
		const href = m[1];
		// Skip absolute URLs and data URIs
		if (/^https?:|^\/\/|^data:/iu.test(href)) continue;
		// Resolve relative to the HTML file's directory
		const rel = join(htmlDir, href).replace(/\\/gu, '/');
		// Safety: skip traversal
		if (rel.startsWith('..') || posix.isAbsolute(rel)) continue;
		results.push(rel);
	}
	return results;
}

/**
 * Check one HTML file against its linked CSS files.
 * Returns issues where a CSS selector targets an id/class absent from the HTML.
 *
 * @param {string} cwd
 * @param {string} htmlPath  Workspace-relative.
 * @param {string} htmlContent
 * @param {Map<string,string>} cssContentMap  Map from workspace-relative CSS path → content.
 * @returns {Array<{type: string, htmlPath: string, cssPath: string, selector: string, value: string}>}
 */
export function checkHtmlCssSelectors(
	cwd,
	htmlPath,
	htmlContent,
	cssContentMap,
) {
	const htmlAttrs = extractHtmlAttributes(htmlContent);
	const linkedCss = extractLinkedCssPaths(htmlContent, htmlPath);
	const issues = [];

	for (const cssPath of linkedCss) {
		const cssContent = cssContentMap.get(cssPath);
		if (!cssContent) continue;
		const { ids, classes } = extractCssSelectors(cssContent);

		for (const id of ids) {
			if (!htmlAttrs.ids.has(id)) {
				issues.push({
					cssPath,
					htmlPath,
					selector: `#${id}`,
					type: 'selector-no-element',
					value: id,
				});
			}
		}
		for (const cls of classes) {
			if (!htmlAttrs.classes.has(cls)) {
				issues.push({
					cssPath,
					htmlPath,
					selector: `.${cls}`,
					type: 'selector-no-element',
					value: cls,
				});
			}
		}
	}
	return issues;
}

/**
 * Run the CSS selector ↔ HTML sensor across all written files.
 * Only runs when at least one HTML or CSS file is in the write set.
 *
 * @param {string} cwd          Workspace root (absolute path).
 * @param {string[]} writePaths Workspace-relative written file paths.
 * @returns {Promise<{sensor: string, status: 'ok'|'warn'|'skipped', checked: number, issues: object[], message: string}>}
 */
export async function runCssSelectorSensor(cwd, writePaths) {
	const htmlPaths = writePaths.filter((p) =>
		HTML_EXTENSIONS.has(extname(p).toLowerCase()),
	);
	const cssPaths = writePaths.filter((p) =>
		CSS_EXTENSIONS.has(extname(p).toLowerCase()),
	);

	if (htmlPaths.length === 0 && cssPaths.length === 0) {
		return {
			sensor: SENSOR_NAMES.CSS_SELECTOR,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no HTML/CSS files in write set',
		};
	}

	// Build a map of all readable CSS files in the write set
	const cssContentMap = new Map();
	for (const p of cssPaths) {
		try {
			cssContentMap.set(p, await readFile(join(cwd, p), 'utf8'));
		} catch {
			// unreadable — skip
		}
	}

	// For HTML files linked to CSS files not in the write set, try to read them
	// from disk so we can still run the check when only the HTML changed.
	const allIssues = [];
	let checked = 0;

	for (const htmlPath of htmlPaths) {
		let htmlContent;
		try {
			htmlContent = await readFile(join(cwd, htmlPath), 'utf8');
		} catch {
			continue;
		}

		// Discover CSS links and read any not already in the map
		const linkedCss = extractLinkedCssPaths(htmlContent, htmlPath);
		for (const cssPath of linkedCss) {
			if (!cssContentMap.has(cssPath)) {
				try {
					cssContentMap.set(
						cssPath,
						await readFile(join(cwd, cssPath), 'utf8'),
					);
				} catch {
					// not present — will be skipped in checkHtmlCssSelectors
				}
			}
		}

		if (
			linkedCss.length === 0 ||
			linkedCss.every((p) => !cssContentMap.has(p))
		) {
			// No linked CSS we can read — skip this HTML file
			continue;
		}

		checked++;
		const issues = checkHtmlCssSelectors(
			cwd,
			htmlPath,
			htmlContent,
			cssContentMap,
		);
		allIssues.push(...issues);
	}

	// Also check CSS files whose linked HTML was not written but may exist on disk
	for (const cssPath of cssPaths) {
		// Find HTML files in the write set that link to this CSS
		const alreadyChecked = new Set(htmlPaths);
		for (const htmlPath of writePaths.filter((p) =>
			HTML_EXTENSIONS.has(extname(p).toLowerCase()),
		)) {
			if (alreadyChecked.has(htmlPath)) continue;
			// already covered above
		}
		// We only need to check HTML files NOT already handled above
		// (htmlPaths already covers them all)
		// No extra work needed here since we process all htmlPaths above.
	}

	if (checked === 0) {
		return {
			sensor: SENSOR_NAMES.CSS_SELECTOR,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no HTML files with readable linked CSS in write set',
		};
	}

	if (allIssues.length === 0) {
		return {
			checked,
			issues: [],
			message: `${checked} HTML file${checked !== 1 ? 's' : ''} ok — all CSS selectors matched`,
			sensor: SENSOR_NAMES.CSS_SELECTOR,
			status: 'ok',
		};
	}

	const summary = allIssues
		.slice(0, 5)
		.map((i) => `${i.selector} not in ${i.htmlPath}`)
		.join('; ');
	const extra = allIssues.length > 5 ? ` (+${allIssues.length - 5} more)` : '';
	return {
		checked,
		issues: allIssues,
		message: `${allIssues.length} selector${allIssues.length !== 1 ? 's' : ''} match no element: ${summary}${extra}`,
		sensor: SENSOR_NAMES.CSS_SELECTOR,
		severity: SENSOR_SEVERITY[SENSOR_NAMES.CSS_SELECTOR],
		status: 'warn',
	};
}

// ---------------------------------------------------------------------------
// Local import-path existence sensor (Phase 167)
// ---------------------------------------------------------------------------

const LOCAL_JS_EXTENSIONS = new Set(['.mjs', '.js', '.cjs']);

// Extension candidates to try when an import has no file extension.
const IMPORT_RESOLVE_EXTS = ['.mjs', '.js', '.cjs'];

/**
 * Extract relative import/export-from specifiers from JS source text.
 * Only returns specifiers that start with '.' or '..' (relative paths).
 *
 * Uses a line-level filter: only scans lines whose first non-whitespace token
 * is the keyword `import` or `export` (followed by space, `{`, or `*`).
 * This avoids false positives from:
 * - `//` line comments  (`// import x from './path'` → skipped)
 * - String literals containing sample code  (`const s = "import x from './f'"` → skipped)
 * - Identifiers starting with `import`/`export`  (`imports.push(...)` → skipped)
 * The trade-off is that multi-line imports where the `from` clause is on its
 * own continuation line are not detected — acceptable because the model
 * primarily writes single-line imports, and false negatives are safer than
 * false positives for an advisory sensor.
 *
 * @param {string} content  Source text of a JS file.
 * @returns {string[]}  Array of relative specifier strings (e.g. ['./utils.mjs', '../lib']).
 */
export function extractLocalImportPaths(content) {
	const patterns = [
		// import ... from './path' and export ... from './path'
		/\bfrom\s+['"](\.[^'"]+)['"]/gu,
		// import './path' (side-effect)
		/\bimport\s+['"](\.[^'"]+)['"]/gu,
	];
	const found = new Set();
	for (const line of content.split('\n')) {
		const trimmed = line.trimStart();
		// Require import/export to be a keyword (followed by whitespace, {, or *)
		// not a prefix of an identifier like `imports.push(...)` or `exports.foo`.
		if (!/^(?:import|export)[\s{*]/u.test(trimmed)) continue;
		for (const re of patterns) {
			re.lastIndex = 0;
			let m;
			while ((m = re.exec(trimmed)) !== null) {
				found.add(m[1]);
			}
		}
	}
	return [...found];
}

/**
 * Resolve a relative import specifier against an importer directory.
 * Returns the absolute path of the resolved file, or null if not found.
 * Internal helper shared by resolveLocalImport and buildImportGraph.
 *
 * @param {string} specifier      Relative import path (e.g. './utils' or '../lib/foo.mjs').
 * @param {string} importerAbsDir Absolute directory of the importing file.
 * @returns {Promise<string|null>}
 */
async function resolveLocalImportAbs(specifier, importerAbsDir) {
	const hasExt = Boolean(extname(specifier));
	const candidates = [specifier];
	if (!hasExt) {
		for (const ext of IMPORT_RESOLVE_EXTS) {
			candidates.push(specifier + ext);
		}
		for (const ext of IMPORT_RESOLVE_EXTS) {
			candidates.push(specifier + '/index' + ext);
		}
	}
	for (const candidate of candidates) {
		const abs = join(importerAbsDir, candidate);
		try {
			await access(abs);
			return abs;
		} catch {
			// try next
		}
	}
	return null;
}

/**
 * Resolve a relative import specifier against an importer directory.
 * Returns true when the target file exists on disk.
 *
 * @param {string} specifier      Relative import path (e.g. './utils' or '../lib/foo.mjs').
 * @param {string} importerAbsDir Absolute directory of the importing file.
 * @returns {Promise<boolean>}
 */
export async function resolveLocalImport(specifier, importerAbsDir) {
	return (await resolveLocalImportAbs(specifier, importerAbsDir)) !== null;
}

/**
 * Run the local import-path existence sensor on a set of written files.
 * Flags relative import/export-from specifiers that resolve to no file on disk.
 *
 * @param {string}   cwd        Workspace root (absolute path).
 * @param {string[]} writePaths Workspace-relative written file paths.
 * @returns {Promise<{sensor: string, status: 'ok'|'warn'|'skipped', checked: number, issues: object[], message: string}>}
 */
export async function runLocalImportSensor(cwd, writePaths) {
	const jsPaths = writePaths.filter((p) =>
		LOCAL_JS_EXTENSIONS.has(extname(p).toLowerCase()),
	);
	if (jsPaths.length === 0) {
		return {
			sensor: SENSOR_NAMES.LOCAL_IMPORT,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no JS files in write set',
		};
	}

	let checked = 0;
	const allIssues = [];

	for (const jsPath of jsPaths) {
		const abs = join(cwd, jsPath);
		let content;
		try {
			content = await readFile(abs, 'utf8');
		} catch {
			continue;
		}
		checked++;
		const specifiers = extractLocalImportPaths(content);
		const fileDir = dirname(abs);

		for (const specifier of specifiers) {
			const resolved = await resolveLocalImportAbs(specifier, fileDir);
			if (!resolved) {
				allIssues.push({ jsPath, specifier });
			}
		}
	}

	if (checked === 0) {
		return {
			sensor: SENSOR_NAMES.LOCAL_IMPORT,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no readable JS files in write set',
		};
	}

	if (allIssues.length === 0) {
		return {
			checked,
			issues: [],
			message: `${checked} file${checked !== 1 ? 's' : ''} ok — all local imports resolve`,
			sensor: SENSOR_NAMES.LOCAL_IMPORT,
			status: 'ok',
		};
	}

	const summary = allIssues
		.slice(0, 5)
		.map((i) => `${i.jsPath} imports '${i.specifier}'`)
		.join('; ');
	const extra = allIssues.length > 5 ? ` (+${allIssues.length - 5} more)` : '';
	return {
		checked,
		issues: allIssues,
		message: `${allIssues.length} unresolved local import${allIssues.length !== 1 ? 's' : ''}: ${summary}${extra}`,
		sensor: SENSOR_NAMES.LOCAL_IMPORT,
		severity: SENSOR_SEVERITY[SENSOR_NAMES.LOCAL_IMPORT],
		status: 'warn',
	};
}

// ---------------------------------------------------------------------------
// Import cycle detection sensor (Phase 172)
// ---------------------------------------------------------------------------

/**
 * Build a dependency graph from a set of JS files within the write set.
 * Only edges where both the importer and the imported file are in jsPaths
 * are recorded (intra-set edges), so cycles that span outside the write set
 * are not detected. Returns { graph: Map<path, path[]>, readCount: number }.
 *
 * @param {string}   cwd
 * @param {string[]} jsPaths  Workspace-relative JS paths.
 * @returns {Promise<{ graph: Map<string, string[]>, readCount: number }>}
 */
async function buildImportGraph(cwd, jsPaths) {
	const pathSet = new Set(jsPaths);
	const graph = new Map();
	let readCount = 0;

	for (const jsPath of jsPaths) {
		graph.set(jsPath, []);
		const abs = join(cwd, jsPath);
		let content;
		try {
			content = await readFile(abs, 'utf8');
		} catch {
			continue;
		}
		readCount++;
		const fileDir = dirname(abs);

		for (const specifier of extractLocalImportPaths(content)) {
			const resolved = await resolveLocalImportAbs(specifier, fileDir);
			if (!resolved) continue;
			const rel = relative(cwd, resolved).replace(/\\/gu, '/');
			if (pathSet.has(rel) && rel !== jsPath) {
				graph.get(jsPath).push(rel);
			}
		}
	}

	return { graph, readCount };
}

/**
 * Canonicalize a cycle array for deduplication.
 * Rotates so the lexicographically smallest node is first.
 *
 * @param {string[]} cycle  e.g. ['b.mjs', 'c.mjs', 'b.mjs']
 * @returns {string}
 */
function canonicalizeCycle(cycle) {
	const nodes = cycle.slice(0, -1);
	const minIdx = nodes.reduce(
		(best, node, i) => (node < nodes[best] ? i : best),
		0,
	);
	const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
	return rotated.join('\0');
}

/**
 * Run DFS on an import graph to find circular dependency chains.
 * Returns an array of cycles, each represented as a path array where the
 * first and last elements are the same node (e.g. ['a.mjs', 'b.mjs', 'a.mjs']).
 * Equivalent cycles starting from different nodes are deduplicated.
 *
 * @param {Map<string, string[]>} graph
 * @returns {string[][]}
 */
export function findCycles(graph) {
	const cycles = [];
	const canonical = new Set();
	const visited = new Set();
	const visiting = new Set();
	const stack = [];

	function dfs(node) {
		if (visited.has(node)) return;
		visiting.add(node);
		stack.push(node);

		for (const neighbor of graph.get(node) ?? []) {
			if (visiting.has(neighbor)) {
				const start = stack.indexOf(neighbor);
				const cycle = [...stack.slice(start), neighbor];
				const key = canonicalizeCycle(cycle);
				if (!canonical.has(key)) {
					canonical.add(key);
					cycles.push(cycle);
				}
			} else if (!visited.has(neighbor)) {
				dfs(neighbor);
			}
		}

		stack.pop();
		visiting.delete(node);
		visited.add(node);
	}

	for (const node of graph.keys()) {
		dfs(node);
	}

	return cycles;
}

/**
 * Build a full transitive import graph from a set of seed JS files,
 * following imports into existing workspace files beyond the seed set.
 * Used by the --deep cycle detection mode.
 *
 * @param {string}   cwd
 * @param {string[]} seedPaths  Workspace-relative JS paths to start from.
 * @returns {Promise<{ graph: Map<string, string[]>, readCount: number }>}
 */
async function buildDeepImportGraph(cwd, seedPaths) {
	const graph = new Map();
	const queue = [...seedPaths];
	const queued = new Set(seedPaths);
	let readCount = 0;

	while (queue.length > 0) {
		const jsPath = queue.shift();
		if (!graph.has(jsPath)) graph.set(jsPath, []);
		const abs = join(cwd, jsPath);
		let content;
		try {
			content = await readFile(abs, 'utf8');
		} catch {
			continue;
		}
		readCount++;
		const fileDir = dirname(abs);

		for (const specifier of extractLocalImportPaths(content)) {
			const resolved = await resolveLocalImportAbs(specifier, fileDir);
			if (!resolved) continue;
			const rel = relative(cwd, resolved).replace(/\\/gu, '/');
			if (rel === jsPath) continue;
			if (!graph.has(rel)) graph.set(rel, []);
			graph.get(jsPath).push(rel);
			if (!queued.has(rel)) {
				queued.add(rel);
				queue.push(rel);
			}
		}
	}

	return { graph, readCount };
}

/**
 * Run the import cycle sensor on a set of written JS files.
 * Detects circular import chains within the write set.
 * With opts.deep, follows imports transitively into existing workspace files
 * (full transitive closure from the write set), only reporting cycles that
 * include at least one file from the write set.
 *
 * @param {string}   cwd
 * @param {string[]} writePaths  Workspace-relative written file paths.
 * @param {object}   [opts]      { deep?: boolean }
 * @returns {Promise<{sensor: string, status: 'ok'|'warn'|'skipped', checked: number, issues: object[], message: string}>}
 */
export async function runImportCycleSensor(cwd, writePaths, opts = {}) {
	const jsPaths = writePaths.filter((p) =>
		LOCAL_JS_EXTENSIONS.has(extname(p).toLowerCase()),
	);
	if (jsPaths.length === 0) {
		return {
			sensor: SENSOR_NAMES.IMPORT_CYCLES,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no JS files in write set',
		};
	}

	const { graph, readCount } = opts.deep
		? await buildDeepImportGraph(cwd, jsPaths)
		: await buildImportGraph(cwd, jsPaths);

	if (readCount === 0) {
		return {
			sensor: SENSOR_NAMES.IMPORT_CYCLES,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no readable JS files in write set',
		};
	}

	let cycles = findCycles(graph);

	if (opts.deep && cycles.length > 0) {
		const writeSet = new Set(jsPaths);
		cycles = cycles.filter((c) => c.some((node) => writeSet.has(node)));
	}

	if (cycles.length === 0) {
		const modeNote = opts.deep ? ' (transitive)' : '';
		return {
			checked: readCount,
			issues: [],
			message: `${readCount} file${readCount !== 1 ? 's' : ''} ok — no import cycles${modeNote}`,
			sensor: SENSOR_NAMES.IMPORT_CYCLES,
			status: 'ok',
		};
	}

	const issues = cycles.map((c) => ({ cycle: c }));
	const summary = cycles
		.slice(0, 3)
		.map((c) => c.join(' → '))
		.join('; ');
	const extra = cycles.length > 3 ? ` (+${cycles.length - 3} more)` : '';
	return {
		checked: readCount,
		issues,
		message: `${cycles.length} import cycle${cycles.length !== 1 ? 's' : ''}: ${summary}${extra}`,
		sensor: SENSOR_NAMES.IMPORT_CYCLES,
		severity: SENSOR_SEVERITY[SENSOR_NAMES.IMPORT_CYCLES],
		status: 'warn',
	};
}

// ---------------------------------------------------------------------------
// Secret-in-response sensor (Phase 173)
// ---------------------------------------------------------------------------

// Sensitive field names — matches property access, destructuring, and variable
// names that commonly hold secrets.
const SECRET_NAMES =
	/\b(?:password|passwd|pwd|secret|token|credential|api_?key|auth_?key|hash|salt|private_?key)\b/iu;

// Safe variable names that commonly appear near sinks but are NOT secrets.
// These are legitimately returned to clients (OAuth tokens, CSRF tokens, etc.)
// and would otherwise produce false positives.
const SAFE_SECRET_NAMES =
	/\b(?:access_?token|refresh_?token|id_?token|csrf_?token|bearer_?token|auth_?token|x_?csrf)\b/iu;

// Serialisation / response sinks that write data to an untrusted channel.
const SINK_PATTERNS = [
	// res.json(...) / res.send(...) / res.end(...)
	/\bres\s*\.\s*(?:json|send|end)\s*\(/u,
	// JSON.stringify(...)
	/\bJSON\s*\.\s*stringify\s*\(/u,
	// jwt.sign(...) / sign(...)
	/\bjwt\s*\.\s*sign\s*\(|(?<![.\w])sign\s*\(/u,
	// return { ... }  — object literal in return position
	/\breturn\s*\{/u,
];

// Comment pattern that suppresses a sensor warning for the block it appears in.
const IGNORE_COMMENT = /\/\/\s*kodr-ignore:\s*secret-in-response/iu;

/**
 * Scan one JS file for lines where a secret-named value reaches a
 * serialisation or response sink on the same line or within a small window.
 * Returns an array of hit objects { line, lineNo, pattern }.
 *
 * Suppression: a `// kodr-ignore: secret-in-response` comment anywhere in the
 * ±WINDOW surrounding the sink line suppresses that hit.
 * Safe-names allowlist: if the only secret-named tokens in the window are in
 * SAFE_SECRET_NAMES (e.g. `accessToken`), the hit is not reported.
 *
 * @param {string} content
 * @returns {Array<{lineNo: number, line: string, pattern: string}>}
 */
export function scanSecretLeaks(content) {
	const lines = content.split('\n');
	const hits = [];
	const WINDOW = 4;

	for (let i = 0; i < lines.length; i++) {
		const sinkMatch = SINK_PATTERNS.find((p) => p.test(lines[i]));
		if (!sinkMatch) continue;

		const start = Math.max(0, i - WINDOW);
		const end = Math.min(lines.length - 1, i + WINDOW);
		const windowLines = lines.slice(start, end + 1);
		const windowText = windowLines.join('\n');

		// Suppress when `// kodr-ignore: secret-in-response` appears in the window
		if (IGNORE_COMMENT.test(windowText)) continue;

		// Only flag when the window has a secret-named token …
		if (!SECRET_NAMES.test(windowText)) continue;

		// … and that token is NOT exclusively a safe name (access token, etc.)
		// Strategy: strip all safe-name occurrences; if nothing remains, skip.
		const stripped = windowText.replace(SAFE_SECRET_NAMES, '');
		if (!SECRET_NAMES.test(stripped)) continue;

		hits.push({
			line: lines[i].trim(),
			lineNo: i + 1,
			pattern: sinkMatch.source,
		});
	}
	return hits;
}

/**
 * Run the secret-in-response sensor on a set of written JS files.
 * Flags heuristic patterns where secret-named values reach serialisation sinks.
 *
 * @param {string}   cwd
 * @param {string[]} writePaths  Workspace-relative written file paths.
 * @returns {Promise<{sensor: string, status: 'ok'|'warn'|'skipped', checked: number, issues: object[], message: string}>}
 */
export async function runSecretInResponseSensor(cwd, writePaths) {
	const jsPaths = writePaths.filter((p) =>
		LOCAL_JS_EXTENSIONS.has(extname(p).toLowerCase()),
	);
	if (jsPaths.length === 0) {
		return {
			sensor: SENSOR_NAMES.SECRET_IN_RESPONSE,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no JS files in write set',
		};
	}

	let checked = 0;
	const allIssues = [];

	for (const jsPath of jsPaths) {
		let content;
		try {
			content = await readFile(join(cwd, jsPath), 'utf8');
		} catch {
			continue;
		}
		checked++;
		for (const hit of scanSecretLeaks(content)) {
			allIssues.push({ jsPath, ...hit });
		}
	}

	if (checked === 0) {
		return {
			sensor: SENSOR_NAMES.SECRET_IN_RESPONSE,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no readable JS files in write set',
		};
	}

	if (allIssues.length === 0) {
		return {
			checked,
			issues: [],
			message: `${checked} file${checked !== 1 ? 's' : ''} ok — no secret-in-response patterns`,
			sensor: SENSOR_NAMES.SECRET_IN_RESPONSE,
			status: 'ok',
		};
	}

	const summary = allIssues
		.slice(0, 3)
		.map((i) => `${i.jsPath}:${i.lineNo}`)
		.join('; ');
	const extra = allIssues.length > 3 ? ` (+${allIssues.length - 3} more)` : '';
	return {
		checked,
		issues: allIssues,
		message: `${allIssues.length} potential secret leak${allIssues.length !== 1 ? 's' : ''}: ${summary}${extra}`,
		sensor: SENSOR_NAMES.SECRET_IN_RESPONSE,
		severity: SENSOR_SEVERITY[SENSOR_NAMES.SECRET_IN_RESPONSE],
		status: 'warn',
	};
}

// ---------------------------------------------------------------------------
// Secrets-at-rest sensor (Phase 190)
// ---------------------------------------------------------------------------

// Flag .env files but not .env.example/.env.sample/.env.template (those are
// committed-on-purpose safe defaults with no real credentials).
const SECRET_ENV_FILE =
	/(?:^|[/\\])\.env(?!\.(example|sample|template|dist|test|local))(\..+)?$/iu;

// Matches: const/let/var SECRETNAME = 'long-literal' (24+ chars)
// or SECRETNAME = 'long-literal' (assignment without declaration).
// Captures: [1] name token, [2] the literal value.
const HARDCODED_SECRET_RE =
	/(?:const|let|var\s+)?(\w*(?:password|passwd|secret|api_?key|auth_?key|credential|private_?key)\w*)\s*=\s*['"`]([^'"`]{24,})['"`]/iu;

// Placeholder strings that are clearly not real credentials.
const PLACEHOLDER_RE =
	/(?:your|example|change|xxx+|placeholder|dummy|test|sample|insert|replace|<|>)/iu;

// Suppression comment for the at-rest sensor.
const AT_REST_IGNORE = /\/\/\s*kodr-ignore:\s*secrets-at-rest/iu;

/**
 * Scan one JS/TS file for hardcoded secret literals assigned to secret-named
 * variables. Returns hit objects { lineNo, line, name, value }.
 * Suppressed by `// kodr-ignore: secrets-at-rest` on the same line.
 *
 * @param {string} content
 * @returns {Array<{lineNo: number, line: string, name: string, value: string}>}
 */
export function scanSecretsAtRest(content) {
	const lines = content.split('\n');
	const hits = [];
	for (let i = 0; i < lines.length; i++) {
		if (AT_REST_IGNORE.test(lines[i])) continue;
		const m = HARDCODED_SECRET_RE.exec(lines[i]);
		if (!m) continue;
		const value = m[2];
		if (PLACEHOLDER_RE.test(value)) continue;
		// Require the value to look like a real credential: mostly alphanumeric +
		// common token chars, no whitespace.
		if (/\s/u.test(value)) continue;
		hits.push({ lineNo: i + 1, line: lines[i].trim(), name: m[1], value });
	}
	return hits;
}

/**
 * Run the secrets-at-rest sensor.
 * Flags: .env files in the write set; hardcoded credentials in JS source files.
 *
 * @param {string}   cwd
 * @param {string[]} writePaths  Workspace-relative written file paths.
 * @returns {Promise<{sensor: string, status: string, checked: number, issues: object[], message: string, severity: string}>}
 */
export async function runSecretsAtRestSensor(cwd, writePaths) {
	// Nothing to scan if no relevant paths at all
	if (writePaths.length === 0) {
		return {
			sensor: SENSOR_NAMES.SECRETS_AT_REST,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no files in write set',
		};
	}

	const allIssues = [];
	let checked = 0;

	// 1. .env files should not appear in the write set
	for (const p of writePaths) {
		if (SECRET_ENV_FILE.test(p)) {
			checked++;
			allIssues.push({ type: 'env-file', path: p });
		}
	}

	// 2. Hardcoded credential literals in JS source files
	const jsPaths = writePaths.filter((p) =>
		LOCAL_JS_EXTENSIONS.has(extname(p).toLowerCase()),
	);
	for (const jsPath of jsPaths) {
		let content;
		try {
			content = await readFile(join(cwd, jsPath), 'utf8');
		} catch {
			continue;
		}
		checked++;
		for (const hit of scanSecretsAtRest(content)) {
			allIssues.push({ type: 'hardcoded', jsPath, ...hit });
		}
	}

	if (checked === 0) {
		return {
			sensor: SENSOR_NAMES.SECRETS_AT_REST,
			status: 'skipped',
			checked: 0,
			issues: [],
			message: 'no .env or JS files in write set',
		};
	}

	if (allIssues.length === 0) {
		return {
			checked,
			issues: [],
			message: `${checked} file${checked !== 1 ? 's' : ''} ok — no secrets at rest`,
			sensor: SENSOR_NAMES.SECRETS_AT_REST,
			status: 'ok',
		};
	}

	const summary = allIssues
		.slice(0, 3)
		.map((i) =>
			i.type === 'env-file' ? i.path : `${i.jsPath}:${i.lineNo} (${i.name})`,
		)
		.join('; ');
	const extra = allIssues.length > 3 ? ` (+${allIssues.length - 3} more)` : '';
	return {
		checked,
		issues: allIssues,
		message: `${allIssues.length} secret${allIssues.length !== 1 ? 's' : ''} at rest: ${summary}${extra}`,
		sensor: SENSOR_NAMES.SECRETS_AT_REST,
		severity: SENSOR_SEVERITY[SENSOR_NAMES.SECRETS_AT_REST],
		status: 'warn',
	};
}

// ---------------------------------------------------------------------------
// Convenience gate: run all cross-ref sensors when a write was applied
// ---------------------------------------------------------------------------

/**
 * Build a Set of sensor names that are explicitly disabled in sensorToggles.
 * Any sensor name mapped to `false` is disabled; `true` or absent means enabled.
 *
 * @param {object|undefined} sensorToggles
 * @returns {Set<string>}
 */
function buildDisabledSet(sensorToggles) {
	if (!sensorToggles || typeof sensorToggles !== 'object') return new Set();
	return new Set(
		Object.entries(sensorToggles)
			.filter(([, v]) => v === false)
			.map(([k]) => k),
	);
}

/**
 * Run all cross-reference sensors on the write result.
 * Returns an array of sensor results (skipped sensors omitted unless all skip).
 * Called from the pipeline after writes are applied.
 *
 * @param {string} cwd
 * @param {object} writeResult  { applied: boolean, writes: [{ path }] }
 * @param {{enabled?: boolean, deep?: boolean, sensorToggles?: object}} [opts]
 * @returns {Promise<object[]>}  Array of sensor result objects.
 */
export async function runCrossRefSensors(cwd, writeResult, opts = {}) {
	if (opts.enabled === false) return [];
	if (!writeResult?.applied) return [];
	const paths = Array.isArray(writeResult.writes)
		? writeResult.writes.map((w) => w.path).filter(Boolean)
		: [];
	if (paths.length === 0) return [];

	const disabled = buildDisabledSet(opts.sensorToggles);
	const skip = (name) =>
		disabled.has(name)
			? {
					sensor: name,
					status: 'skipped',
					checked: 0,
					issues: [],
					message: 'disabled by project config',
				}
			: null;

	const [compose, css, localImport, cycles, secrets, secretsAtRest] =
		await Promise.all([
			skip(SENSOR_NAMES.COMPOSE_DOCKERFILE) ??
				runComposeDockerfileSensor(cwd, paths),
			skip(SENSOR_NAMES.CSS_SELECTOR) ?? runCssSelectorSensor(cwd, paths),
			skip(SENSOR_NAMES.LOCAL_IMPORT) ?? runLocalImportSensor(cwd, paths),
			skip(SENSOR_NAMES.IMPORT_CYCLES) ??
				runImportCycleSensor(cwd, paths, { deep: opts.deep }),
			skip(SENSOR_NAMES.SECRET_IN_RESPONSE) ??
				runSecretInResponseSensor(cwd, paths),
			skip(SENSOR_NAMES.SECRETS_AT_REST) ?? runSecretsAtRestSensor(cwd, paths),
		]);

	// Omit sensors that skipped (no relevant files or disabled) to keep summary lean
	return [compose, css, localImport, cycles, secrets, secretsAtRest].filter(
		(r) => r.status !== 'skipped',
	);
}

/**
 * Run content-safe sensors on proposed (not-yet-applied) writes.
 *
 * Only sensors that analyse file content without resolving external references
 * are included. Sensors that verify structural references across the workspace
 * (local-import path existence, Dockerfile presence, HTML/CSS co-location) are
 * skipped to avoid false positives when the referenced files exist on disk but
 * are not part of the proposal.
 *
 * Sensors run: import-cycles, secret-in-response, secrets-at-rest.
 * Sensors skipped (apply-only): local-import, css-selector, compose-dockerfile.
 *
 * Results carry a `proposalOnly: true` marker so callers can present them
 * separately from post-apply sensor results.
 *
 * @param {Array<{path: string, content: string}>} proposalFiles
 * @param {{enabled?: boolean, sensorToggles?: object}} [opts]
 * @returns {Promise<object[]>}
 */
export async function runCrossRefSensorsOnProposal(proposalFiles, opts = {}) {
	if (opts.enabled === false) return [];
	const writes = (proposalFiles ?? []).filter(
		(f) => f?.path && typeof f.content === 'string',
	);
	if (writes.length === 0) return [];

	const disabled = buildDisabledSet(opts.sensorToggles);
	const skip = (name) =>
		disabled.has(name)
			? {
					sensor: name,
					status: 'skipped',
					checked: 0,
					issues: [],
					message: 'disabled by project config',
				}
			: null;

	const tmpDir = await mkdtemp(join(tmpdir(), 'kodr-proposal-'));
	try {
		const paths = [];
		for (const { path, content } of writes) {
			const absPath = join(tmpDir, path);
			await mkdir(dirname(absPath), { recursive: true });
			await writeFile(absPath, content, 'utf8');
			paths.push(path);
		}

		const [cycles, secrets, secretsAtRest] = await Promise.all([
			skip(SENSOR_NAMES.IMPORT_CYCLES) ??
				runImportCycleSensor(tmpDir, paths, { deep: false }),
			skip(SENSOR_NAMES.SECRET_IN_RESPONSE) ??
				runSecretInResponseSensor(tmpDir, paths),
			skip(SENSOR_NAMES.SECRETS_AT_REST) ??
				runSecretsAtRestSensor(tmpDir, paths),
		]);

		return [cycles, secrets, secretsAtRest]
			.filter((r) => r.status !== 'skipped')
			.map((r) => ({ ...r, proposalOnly: true }));
	} finally {
		await rm(tmpDir, { recursive: true, force: true });
	}
}
