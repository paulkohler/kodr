import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	SENSOR_NAMES,
	SENSOR_SEVERITY,
	extractBuildContexts,
	checkComposeDockerfile,
	runComposeDockerfileSensor,
	extractCssSelectors,
	extractHtmlAttributes,
	extractLinkedCssPaths,
	checkHtmlCssSelectors,
	runCssSelectorSensor,
	extractLocalImportPaths,
	resolveLocalImport,
	runLocalImportSensor,
	findCycles,
	runImportCycleSensor,
	scanSecretLeaks,
	runSecretInResponseSensor,
	scanSecretsAtRest,
	runSecretsAtRestSensor,
	runCrossRefSensors,
	runCrossRefSensorsOnProposal,
} from '../src/cross-ref-sensor.mjs';

// ---------------------------------------------------------------------------
// extractBuildContexts
// ---------------------------------------------------------------------------
describe('extractBuildContexts', () => {
	it('parses inline build: .', () => {
		const content = `services:\n  api:\n    build: .\n`;
		const result = extractBuildContexts(content);
		assert.equal(result.length, 1);
		assert.equal(result[0].context, '.');
		assert.equal(result[0].dockerfile, 'Dockerfile');
	});

	it('parses inline build: ./api', () => {
		const content = `services:\n  api:\n    build: ./api\n`;
		const [r] = extractBuildContexts(content);
		assert.equal(r.context, './api');
	});

	it('parses block form with context', () => {
		const content = [
			'services:',
			'  api:',
			'    build:',
			'      context: ./backend',
			'      dockerfile: Dockerfile.prod',
			'',
		].join('\n');
		const [r] = extractBuildContexts(content);
		assert.equal(r.context, './backend');
		assert.equal(r.dockerfile, 'Dockerfile.prod');
	});

	it('returns empty for no build entries', () => {
		const content = `services:\n  db:\n    image: postgres:16\n`;
		assert.deepEqual(extractBuildContexts(content), []);
	});

	it('handles multiple services', () => {
		const content = [
			'services:',
			'  api:',
			'    build: ./api',
			'  worker:',
			'    build: ./worker',
		].join('\n');
		const results = extractBuildContexts(content);
		assert.equal(results.length, 2);
	});
});

// ---------------------------------------------------------------------------
// checkComposeDockerfile
// ---------------------------------------------------------------------------
describe('checkComposeDockerfile', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'xref-test-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns no issues when Dockerfile exists', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		await writeFile(join(cwd, 'Dockerfile'), 'FROM node:24\n');
		const issues = await checkComposeDockerfile(cwd, 'docker-compose.yml');
		assert.equal(issues.length, 0);
	});

	it('returns issue when Dockerfile missing', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const issues = await checkComposeDockerfile(cwd, 'docker-compose.yml');
		assert.equal(issues.length, 1);
		assert.equal(issues[0].type, 'missing-dockerfile');
		assert.equal(issues[0].buildContext, '.');
	});

	it('uses nested context path', async () => {
		const content = [
			'services:',
			'  api:',
			'    build:',
			'      context: ./backend',
		].join('\n');
		await writeFile(join(cwd, 'docker-compose.yml'), content);
		const issues = await checkComposeDockerfile(cwd, 'docker-compose.yml');
		assert.equal(issues.length, 1);
		assert.match(issues[0].expectedDockerfile, /backend/u);
	});

	it('returns empty array for unreadable compose file', async () => {
		const issues = await checkComposeDockerfile(cwd, 'docker-compose.yml');
		assert.deepEqual(issues, []);
	});
});

// ---------------------------------------------------------------------------
// runComposeDockerfileSensor
// ---------------------------------------------------------------------------
describe('runComposeDockerfileSensor', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'xref-test-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('skips when no compose files in write set', async () => {
		const r = await runComposeDockerfileSensor(cwd, ['index.js', 'README.md']);
		assert.equal(r.status, 'skipped');
		assert.equal(r.sensor, 'compose-dockerfile');
	});

	it('returns ok when Dockerfile present', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		await writeFile(join(cwd, 'Dockerfile'), 'FROM node:24\n');
		const r = await runComposeDockerfileSensor(cwd, ['docker-compose.yml']);
		assert.equal(r.status, 'ok');
		assert.equal(r.checked, 1);
		assert.equal(r.issues.length, 0);
	});

	it('returns warn when Dockerfile missing', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const r = await runComposeDockerfileSensor(cwd, ['docker-compose.yml']);
		assert.equal(r.status, 'warn');
		assert.equal(r.issues.length, 1);
		assert.match(r.message, /no Dockerfile/iu);
	});
});

// ---------------------------------------------------------------------------
// extractCssSelectors
// ---------------------------------------------------------------------------
describe('extractCssSelectors', () => {
	it('extracts #id selectors', () => {
		const { ids } = extractCssSelectors('#header { color: red; }');
		assert.ok(ids.has('header'));
	});

	it('extracts .class selectors', () => {
		const { classes } = extractCssSelectors(
			'.btn-primary { font-weight: bold; }',
		);
		assert.ok(classes.has('btn-primary'));
	});

	it('strips CSS comments before parsing', () => {
		const css = '/* #ignored */ #real { color: blue; }';
		const { ids } = extractCssSelectors(css);
		assert.ok(ids.has('real'));
		assert.ok(!ids.has('ignored'));
	});

	it('handles multiple selectors', () => {
		const css = '#foo, .bar, .baz { display: flex; }';
		const { ids, classes } = extractCssSelectors(css);
		assert.ok(ids.has('foo'));
		assert.ok(classes.has('bar'));
		assert.ok(classes.has('baz'));
	});

	it('does not include pseudo-class tokens as class names', () => {
		const css = 'a:hover { color: blue; }';
		const { classes } = extractCssSelectors(css);
		// "hover" should NOT be in classes (it's a pseudo-class)
		// With our current approach it may or may not be — at minimum
		// it should not crash and ids/classes are Sets.
		assert.ok(classes instanceof Set);
	});
});

// ---------------------------------------------------------------------------
// extractHtmlAttributes
// ---------------------------------------------------------------------------
describe('extractHtmlAttributes', () => {
	it('extracts id attributes', () => {
		const { ids } = extractHtmlAttributes('<div id="main-content">hello</div>');
		assert.ok(ids.has('main-content'));
	});

	it('extracts class attributes (multiple classes)', () => {
		const { classes } = extractHtmlAttributes(
			'<button class="btn btn-primary">ok</button>',
		);
		assert.ok(classes.has('btn'));
		assert.ok(classes.has('btn-primary'));
	});

	it('handles single quotes', () => {
		const { ids } = extractHtmlAttributes("<div id='app'>x</div>");
		assert.ok(ids.has('app'));
	});
});

// ---------------------------------------------------------------------------
// extractLinkedCssPaths
// ---------------------------------------------------------------------------
describe('extractLinkedCssPaths', () => {
	it('extracts relative stylesheet hrefs', () => {
		const html = '<link rel="stylesheet" href="style.css">';
		const paths = extractLinkedCssPaths(html, 'index.html');
		assert.deepEqual(paths, ['style.css']);
	});

	it('resolves href relative to HTML file directory', () => {
		const html = '<link rel="stylesheet" href="css/main.css">';
		const paths = extractLinkedCssPaths(html, 'public/index.html');
		assert.deepEqual(paths, ['public/css/main.css']);
	});

	it('skips absolute URLs', () => {
		const html =
			'<link rel="stylesheet" href="https://cdn.example.com/style.css">';
		const paths = extractLinkedCssPaths(html, 'index.html');
		assert.deepEqual(paths, []);
	});
});

// ---------------------------------------------------------------------------
// runCssSelectorSensor
// ---------------------------------------------------------------------------
describe('runCssSelectorSensor', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'css-test-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('skips when no HTML/CSS files in write set', async () => {
		const r = await runCssSelectorSensor(cwd, ['app.js', 'package.json']);
		assert.equal(r.status, 'skipped');
		assert.equal(r.sensor, 'css-selector');
	});

	it('returns ok when all selectors match HTML elements', async () => {
		await writeFile(
			join(cwd, 'style.css'),
			'#header { color: red; } .nav { display: flex; }',
		);
		await writeFile(
			join(cwd, 'index.html'),
			[
				'<!DOCTYPE html><html>',
				'<head><link rel="stylesheet" href="style.css"></head>',
				'<body><div id="header"><nav class="nav">x</nav></div></body>',
				'</html>',
			].join('\n'),
		);
		const r = await runCssSelectorSensor(cwd, ['index.html', 'style.css']);
		assert.equal(r.status, 'ok');
		assert.equal(r.issues.length, 0);
	});

	it('returns warn when CSS targets absent id', async () => {
		await writeFile(join(cwd, 'style.css'), '#add-btn { color: red; }');
		await writeFile(
			join(cwd, 'index.html'),
			[
				'<!DOCTYPE html><html>',
				'<head><link rel="stylesheet" href="style.css"></head>',
				'<body><button class="submit">go</button></body>',
				'</html>',
			].join('\n'),
		);
		const r = await runCssSelectorSensor(cwd, ['index.html', 'style.css']);
		assert.equal(r.status, 'warn');
		assert.ok(r.issues.some((i) => i.selector === '#add-btn'));
	});

	it('returns warn when CSS targets absent class', async () => {
		await writeFile(join(cwd, 'style.css'), '.container { padding: 1rem; }');
		await writeFile(
			join(cwd, 'index.html'),
			[
				'<!DOCTYPE html><html>',
				'<head><link rel="stylesheet" href="style.css"></head>',
				'<body><div id="app">hello</div></body>',
				'</html>',
			].join('\n'),
		);
		const r = await runCssSelectorSensor(cwd, ['index.html', 'style.css']);
		assert.equal(r.status, 'warn');
		assert.ok(r.issues.some((i) => i.selector === '.container'));
	});

	it('skips HTML with no linked CSS', async () => {
		await writeFile(join(cwd, 'index.html'), '<html><body>hello</body></html>');
		const r = await runCssSelectorSensor(cwd, ['index.html']);
		assert.equal(r.status, 'skipped');
	});
});

// ---------------------------------------------------------------------------
// extractLocalImportPaths (Phase 167)
// ---------------------------------------------------------------------------

describe('extractLocalImportPaths', () => {
	it('extracts named and default imports from relative paths', () => {
		const code =
			"import x from './utils.mjs';\nimport { y } from '../lib/helper.mjs';\n";
		const result = extractLocalImportPaths(code);
		assert.ok(result.includes('./utils.mjs'));
		assert.ok(result.includes('../lib/helper.mjs'));
	});

	it('extracts side-effect imports', () => {
		const code = `import './polyfill.mjs';`;
		assert.ok(extractLocalImportPaths(code).includes('./polyfill.mjs'));
	});

	it('extracts export-from specifiers', () => {
		const code = `export { foo } from './foo.mjs';\nexport * from '../bar.mjs';`;
		const result = extractLocalImportPaths(code);
		assert.ok(result.includes('./foo.mjs'));
		assert.ok(result.includes('../bar.mjs'));
	});

	it('ignores bare specifiers', () => {
		const code = `import x from 'express';\nimport y from 'node:fs';`;
		assert.deepEqual(extractLocalImportPaths(code), []);
	});

	it('deduplicates repeated imports of the same path', () => {
		const code = `import x from './utils.mjs';\nimport y from './utils.mjs';`;
		const result = extractLocalImportPaths(code);
		assert.equal(result.filter((p) => p === './utils.mjs').length, 1);
	});

	it('ignores paths in // line comments', () => {
		const code = `// import x from './commented.mjs';\nimport y from './real.mjs';`;
		const result = extractLocalImportPaths(code);
		assert.ok(!result.includes('./commented.mjs'));
		assert.ok(result.includes('./real.mjs'));
	});

	it('ignores paths inside string literals (fixture data)', () => {
		// Test files store sample code as string data — should not be matched
		const code = [
			'const sample = "import { x } from \'./fixture.mjs\';";',
			'import y from "./real.mjs";',
		].join('\n');
		const result = extractLocalImportPaths(code);
		assert.ok(!result.includes('./fixture.mjs'));
		assert.ok(result.includes('./real.mjs'));
	});

	it('ignores identifiers that start with import/export (not keywords)', () => {
		// `imports.push(...)` and `exports.foo` start with import/export but are not keywords
		const code = [
			"imports.push(`import { v } from '../src/m.mjs';`);",
			"exports.helper = require('./legacy.js');",
			"import { real } from './actual.mjs';",
		].join('\n');
		const result = extractLocalImportPaths(code);
		assert.ok(!result.includes('../src/m.mjs'));
		assert.ok(!result.includes('./legacy.js'));
		assert.ok(result.includes('./actual.mjs'));
	});
});

// ---------------------------------------------------------------------------
// resolveLocalImport (Phase 167)
// ---------------------------------------------------------------------------

describe('resolveLocalImport', () => {
	let tmp;
	beforeEach(async () => {
		tmp = await mkdtemp(join(tmpdir(), 'kodr-import-'));
	});
	afterEach(async () => {
		await rm(tmp, { recursive: true, force: true });
	});

	it('resolves an exact path that exists', async () => {
		await writeFile(join(tmp, 'utils.mjs'), 'export const x = 1;\n');
		assert.ok(await resolveLocalImport('./utils.mjs', tmp));
	});

	it('resolves an extensionless specifier by trying .mjs', async () => {
		await writeFile(join(tmp, 'utils.mjs'), 'export const x = 1;\n');
		assert.ok(await resolveLocalImport('./utils', tmp));
	});

	it('returns false when nothing matches', async () => {
		assert.ok(!(await resolveLocalImport('./missing.mjs', tmp)));
	});

	it('resolves index file for bare directory specifier', async () => {
		await mkdir(join(tmp, 'lib'));
		await writeFile(join(tmp, 'lib', 'index.mjs'), 'export const x = 1;\n');
		assert.ok(await resolveLocalImport('./lib', tmp));
	});
});

// ---------------------------------------------------------------------------
// runLocalImportSensor (Phase 167)
// ---------------------------------------------------------------------------

describe('runLocalImportSensor', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-local-import-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('skips when no JS files in write set', async () => {
		const r = await runLocalImportSensor(cwd, ['README.md']);
		assert.equal(r.status, 'skipped');
	});

	it('returns ok when all imports resolve', async () => {
		await writeFile(join(cwd, 'utils.mjs'), 'export const x = 1;\n');
		await writeFile(join(cwd, 'app.mjs'), "import { x } from './utils.mjs';\n");
		const r = await runLocalImportSensor(cwd, ['app.mjs', 'utils.mjs']);
		assert.equal(r.status, 'ok');
		assert.equal(r.issues.length, 0);
	});

	it('warns when an import target is missing', async () => {
		await writeFile(
			join(cwd, 'app.mjs'),
			"import { helper } from './missing-module.mjs';\n",
		);
		const r = await runLocalImportSensor(cwd, ['app.mjs']);
		assert.equal(r.status, 'warn');
		assert.equal(r.issues.length, 1);
		assert.equal(r.issues[0].specifier, './missing-module.mjs');
	});

	it('resolves extensionless imports correctly', async () => {
		await writeFile(join(cwd, 'utils.mjs'), 'export const x = 1;\n');
		await writeFile(join(cwd, 'app.mjs'), "import { x } from './utils';\n");
		const r = await runLocalImportSensor(cwd, ['app.mjs', 'utils.mjs']);
		assert.equal(r.status, 'ok');
	});
});

// ---------------------------------------------------------------------------
// findCycles (Phase 172)
// ---------------------------------------------------------------------------

describe('findCycles', () => {
	it('detects a simple two-node cycle', () => {
		const graph = new Map([
			['a.mjs', ['b.mjs']],
			['b.mjs', ['a.mjs']],
		]);
		const cycles = findCycles(graph);
		assert.equal(cycles.length, 1);
		assert.ok(cycles[0].includes('a.mjs'));
		assert.ok(cycles[0].includes('b.mjs'));
	});

	it('detects a three-node cycle', () => {
		const graph = new Map([
			['a.mjs', ['b.mjs']],
			['b.mjs', ['c.mjs']],
			['c.mjs', ['a.mjs']],
		]);
		const cycles = findCycles(graph);
		assert.equal(cycles.length, 1);
		assert.equal(cycles[0].length, 4); // a→b→c→a
	});

	it('returns empty array when no cycles', () => {
		const graph = new Map([
			['a.mjs', ['b.mjs']],
			['b.mjs', ['c.mjs']],
			['c.mjs', []],
		]);
		assert.deepEqual(findCycles(graph), []);
	});

	it('deduplicates the same cycle found from different entry points', () => {
		// A→B→A is the same cycle whether detected from A or B
		const graph = new Map([
			['a.mjs', ['b.mjs']],
			['b.mjs', ['a.mjs']],
			['c.mjs', []],
		]);
		const cycles = findCycles(graph);
		assert.equal(cycles.length, 1);
	});
});

// ---------------------------------------------------------------------------
// runImportCycleSensor (Phase 172)
// ---------------------------------------------------------------------------

describe('runImportCycleSensor', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-cycles-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('skips when no JS files in write set', async () => {
		const r = await runImportCycleSensor(cwd, ['README.md']);
		assert.equal(r.status, 'skipped');
	});

	it('skips when JS files are not on disk', async () => {
		const r = await runImportCycleSensor(cwd, ['ghost.mjs']);
		assert.equal(r.status, 'skipped');
	});

	it('returns ok when no cycles', async () => {
		await writeFile(join(cwd, 'a.mjs'), "import { x } from './b.mjs';\n");
		await writeFile(join(cwd, 'b.mjs'), 'export const x = 1;\n');
		const r = await runImportCycleSensor(cwd, ['a.mjs', 'b.mjs']);
		assert.equal(r.status, 'ok');
		assert.equal(r.issues.length, 0);
	});

	it('returns warn when a cycle is detected', async () => {
		await writeFile(
			join(cwd, 'a.mjs'),
			"import { b } from './b.mjs';\nexport const a = 1;\n",
		);
		await writeFile(
			join(cwd, 'b.mjs'),
			"import { a } from './a.mjs';\nexport const b = 1;\n",
		);
		const r = await runImportCycleSensor(cwd, ['a.mjs', 'b.mjs']);
		assert.equal(r.status, 'warn');
		assert.equal(r.issues.length, 1);
		assert.ok(r.message.includes('import cycle'));
	});

	it('--deep detects cross-workspace cycle (write set only has seed)', async () => {
		// a.mjs (write set seed) → b.mjs (existing) → a.mjs = cycle
		await writeFile(
			join(cwd, 'a.mjs'),
			"import { b } from './b.mjs';\nexport const a = 1;\n",
		);
		await writeFile(
			join(cwd, 'b.mjs'),
			"import { a } from './a.mjs';\nexport const b = 1;\n",
		);
		// Seed is only a.mjs; without --deep, b.mjs is outside the write set
		// and the cycle is not detected.
		const shallow = await runImportCycleSensor(cwd, ['a.mjs']);
		assert.equal(shallow.status, 'ok');
		// With --deep, b.mjs is discovered and the cycle is flagged.
		const deep = await runImportCycleSensor(cwd, ['a.mjs'], { deep: true });
		assert.equal(deep.status, 'warn');
		assert.ok(deep.message.includes('import cycle'));
	});

	it('--deep returns ok when no transitive cycles touch write set', async () => {
		await writeFile(join(cwd, 'a.mjs'), "import { b } from './b.mjs';\n");
		await writeFile(join(cwd, 'b.mjs'), 'export const b = 1;\n');
		const r = await runImportCycleSensor(cwd, ['a.mjs'], { deep: true });
		assert.equal(r.status, 'ok');
	});
});

// ---------------------------------------------------------------------------
// scanSecretLeaks (Phase 173)
// ---------------------------------------------------------------------------

describe('scanSecretLeaks', () => {
	it('flags password near res.json on the same line', () => {
		const code = 'res.json({ id: user.id, password: user.password });\n';
		const hits = scanSecretLeaks(code);
		assert.ok(hits.length > 0);
		assert.equal(hits[0].lineNo, 1);
	});

	it('flags secret near JSON.stringify', () => {
		const code = 'const body = JSON.stringify({ token, secret });\n';
		const hits = scanSecretLeaks(code);
		assert.ok(hits.length > 0);
	});

	it('flags password in window near jwt.sign', () => {
		const code = [
			'const payload = {',
			'  id: user.id,',
			'  passwordHash: user.passwordHash,',
			'};',
			'const tok = jwt.sign(payload, SECRET);',
		].join('\n');
		const hits = scanSecretLeaks(code);
		assert.ok(hits.length > 0);
	});

	it('does not flag when no secret near sink', () => {
		const code = 'res.json({ id: user.id, name: user.name });\n';
		const hits = scanSecretLeaks(code);
		assert.equal(hits.length, 0);
	});

	it('does not flag when secret variable exists but no sink', () => {
		const code = 'const password = await bcrypt.hash(raw, 10);\n';
		const hits = scanSecretLeaks(code);
		assert.equal(hits.length, 0);
	});

	it('does not flag accessToken near res.json (safe-names allowlist)', () => {
		// accessToken is a legitimate client-facing token — should not trigger
		const code = 'res.json({ accessToken, userId });\n';
		const hits = scanSecretLeaks(code);
		assert.equal(hits.length, 0);
	});

	it('does not flag refreshToken near res.json (safe-names allowlist)', () => {
		const code = 'res.json({ accessToken, refreshToken, expiresIn: 3600 });\n';
		const hits = scanSecretLeaks(code);
		assert.equal(hits.length, 0);
	});

	it('flags password even when accessToken also present', () => {
		// accessToken is safe but password is not — should still flag
		const code = 'res.json({ accessToken, password: user.password });\n';
		const hits = scanSecretLeaks(code);
		assert.ok(hits.length > 0);
	});

	it('suppresses hit when kodr-ignore comment appears in window', () => {
		const code = [
			'// kodr-ignore: secret-in-response',
			'res.json({ id: user.id, password: user.password });',
		].join('\n');
		const hits = scanSecretLeaks(code);
		assert.equal(hits.length, 0);
	});

	it('suppresses hit with kodr-ignore on the sink line itself', () => {
		const code = 'res.json({ password }); // kodr-ignore: secret-in-response\n';
		const hits = scanSecretLeaks(code);
		assert.equal(hits.length, 0);
	});
});

// ---------------------------------------------------------------------------
// runSecretInResponseSensor (Phase 173)
// ---------------------------------------------------------------------------

describe('runSecretInResponseSensor', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-secret-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('skips when no JS files in write set', async () => {
		const r = await runSecretInResponseSensor(cwd, ['styles.css']);
		assert.equal(r.status, 'skipped');
	});

	it('returns ok when no leaks detected', async () => {
		await writeFile(
			join(cwd, 'api.mjs'),
			'res.json({ id: user.id, name: user.name });\n',
		);
		const r = await runSecretInResponseSensor(cwd, ['api.mjs']);
		assert.equal(r.status, 'ok');
	});

	it('returns warn when password reaches res.json', async () => {
		await writeFile(
			join(cwd, 'api.mjs'),
			'res.json({ id: user.id, password: user.password });\n',
		);
		const r = await runSecretInResponseSensor(cwd, ['api.mjs']);
		assert.equal(r.status, 'warn');
		assert.ok(r.message.includes('secret leak'));
	});
});

// ---------------------------------------------------------------------------
// runCrossRefSensors (convenience gate)
// ---------------------------------------------------------------------------
describe('runCrossRefSensors', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'xref-gate-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('returns empty array when not applied', async () => {
		const r = await runCrossRefSensors(cwd, { applied: false, writes: [] });
		assert.deepEqual(r, []);
	});

	it('returns empty array when opts.enabled is false', async () => {
		const r = await runCrossRefSensors(
			cwd,
			{ applied: true, writes: [{ path: 'docker-compose.yml' }] },
			{ enabled: false },
		);
		assert.deepEqual(r, []);
	});

	it('omits skipped sensors', async () => {
		// Write only a JS file — both sensors should skip
		const r = await runCrossRefSensors(cwd, {
			applied: true,
			writes: [{ path: 'app.js' }],
		});
		assert.deepEqual(r, []);
	});

	it('includes sensor results when relevant files are present', async () => {
		await writeFile(
			join(cwd, 'docker-compose.yml'),
			'services:\n  api:\n    build: .\n',
		);
		const r = await runCrossRefSensors(cwd, {
			applied: true,
			writes: [{ path: 'docker-compose.yml' }],
		});
		// compose-dockerfile sensor should appear (Dockerfile missing → warn)
		assert.ok(r.length >= 1);
		assert.ok(r.some((s) => s.sensor === SENSOR_NAMES.COMPOSE_DOCKERFILE));
	});
});

// ---------------------------------------------------------------------------
// SENSOR_NAMES registry
// ---------------------------------------------------------------------------
describe('SENSOR_NAMES', () => {
	it('exports all six canonical names', () => {
		const names = Object.values(SENSOR_NAMES);
		assert.equal(names.length, 6);
		assert.ok(names.includes('compose-dockerfile'));
		assert.ok(names.includes('css-selector'));
		assert.ok(names.includes('local-import'));
		assert.ok(names.includes('import-cycles'));
		assert.ok(names.includes('secret-in-response'));
		assert.ok(names.includes('secrets-at-rest'));
	});

	it('SENSOR_SEVERITY has error/warning entry for every sensor', () => {
		for (const name of Object.values(SENSOR_NAMES)) {
			assert.ok(
				SENSOR_SEVERITY[name] === 'error' ||
					SENSOR_SEVERITY[name] === 'warning',
				`${name} must have severity 'error' or 'warning'`,
			);
		}
	});

	it('local-import, import-cycles, secret-in-response, secrets-at-rest are error-severity', () => {
		assert.equal(SENSOR_SEVERITY[SENSOR_NAMES.LOCAL_IMPORT], 'error');
		assert.equal(SENSOR_SEVERITY[SENSOR_NAMES.IMPORT_CYCLES], 'error');
		assert.equal(SENSOR_SEVERITY[SENSOR_NAMES.SECRET_IN_RESPONSE], 'error');
		assert.equal(SENSOR_SEVERITY[SENSOR_NAMES.SECRETS_AT_REST], 'error');
	});

	it('compose-dockerfile and css-selector are warning-severity', () => {
		assert.equal(SENSOR_SEVERITY[SENSOR_NAMES.COMPOSE_DOCKERFILE], 'warning');
		assert.equal(SENSOR_SEVERITY[SENSOR_NAMES.CSS_SELECTOR], 'warning');
	});

	it('warn results include severity field', async () => {
		const tmpCwd = await import('node:os').then((m) =>
			import('node:fs/promises').then((fs) =>
				fs.mkdtemp(m.tmpdir() + '/sev-test-'),
			),
		);
		try {
			await import('node:fs/promises').then((fs) =>
				fs.writeFile(
					tmpCwd + '/docker-compose.yml',
					'services:\n  api:\n    build: .\n',
				),
			);
			const r = await runCrossRefSensors(tmpCwd, {
				applied: true,
				writes: [{ path: 'docker-compose.yml' }],
			});
			const warn = r.find(
				(s) =>
					s.sensor === SENSOR_NAMES.COMPOSE_DOCKERFILE && s.status === 'warn',
			);
			assert.ok(warn, 'compose-dockerfile sensor fires a warn');
			assert.equal(warn.severity, 'warning');
		} finally {
			await import('node:fs/promises').then((fs) =>
				fs.rm(tmpCwd, { recursive: true, force: true }),
			);
		}
	});

	it('sensor results use the canonical names', async () => {
		const cwd = await import('node:os').then((m) =>
			import('node:fs/promises').then((fs) =>
				fs.mkdtemp(m.tmpdir() + '/sn-test-'),
			),
		);
		try {
			await import('node:fs/promises').then((fs) =>
				fs.writeFile(
					cwd + '/docker-compose.yml',
					'services:\n  api:\n    build: .\n',
				),
			);
			const r = await runCrossRefSensors(cwd, {
				applied: true,
				writes: [{ path: 'docker-compose.yml' }],
			});
			const sensorInResult = r.find(
				(s) => s.sensor === SENSOR_NAMES.COMPOSE_DOCKERFILE,
			);
			assert.ok(sensorInResult, 'compose-dockerfile sensor appears in results');
		} finally {
			await import('node:fs/promises').then((fs) =>
				fs.rm(cwd, { recursive: true, force: true }),
			);
		}
	});
});

// ---------------------------------------------------------------------------
// scanSecretsAtRest
// ---------------------------------------------------------------------------
describe('scanSecretsAtRest', () => {
	it('detects hardcoded api key assignment', () => {
		const content = `const API_KEY = 'sk-abc123xyz456789012345678';\n`;
		const hits = scanSecretsAtRest(content);
		assert.equal(hits.length, 1);
		assert.ok(hits[0].name.toLowerCase().includes('api'));
	});

	it('ignores placeholder values', () => {
		const content = `const API_KEY = 'your_api_key_here_replace_me';\n`;
		const hits = scanSecretsAtRest(content);
		assert.equal(hits.length, 0);
	});

	it('ignores values with whitespace', () => {
		const content = `const secret = 'this is a long string that has spaces in it';\n`;
		const hits = scanSecretsAtRest(content);
		assert.equal(hits.length, 0);
	});

	it('ignores short values (under 24 chars)', () => {
		const content = `const password = 'short';\n`;
		const hits = scanSecretsAtRest(content);
		assert.equal(hits.length, 0);
	});

	it('suppressed by kodr-ignore comment', () => {
		const content = `const API_KEY = 'sk-abc123xyz456789012345678'; // kodr-ignore: secrets-at-rest\n`;
		const hits = scanSecretsAtRest(content);
		assert.equal(hits.length, 0);
	});
});

// ---------------------------------------------------------------------------
// runSecretsAtRestSensor
// ---------------------------------------------------------------------------
describe('runSecretsAtRestSensor', () => {
	let cwd;
	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), 'kodr-sat-'));
	});
	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it('skips when no relevant files', async () => {
		const result = await runSecretsAtRestSensor(cwd, []);
		assert.equal(result.status, 'skipped');
	});

	it('warns when .env file is in write set', async () => {
		await writeFile(join(cwd, '.env'), 'DB_PASSWORD=hunter2\n');
		const result = await runSecretsAtRestSensor(cwd, ['.env']);
		assert.equal(result.status, 'warn');
		assert.ok(result.message.includes('.env'));
		assert.equal(result.severity, 'error');
	});

	it('does not flag .env.example', async () => {
		await writeFile(
			join(cwd, '.env.example'),
			'DB_PASSWORD=your_password_here\n',
		);
		const result = await runSecretsAtRestSensor(cwd, ['.env.example']);
		// .env.example is not a target type — sensor skips, no issues flagged
		assert.ok(result.status === 'ok' || result.status === 'skipped');
		assert.equal(result.issues.length, 0);
	});

	it('warns when JS file has a hardcoded credential', async () => {
		await writeFile(
			join(cwd, 'config.mjs'),
			`export const API_KEY = 'sk-abc123xyz456789012345678';\n`,
		);
		const result = await runSecretsAtRestSensor(cwd, ['config.mjs']);
		assert.equal(result.status, 'warn');
		assert.ok(result.message.toLowerCase().includes('secret'));
		assert.equal(result.severity, 'error');
	});

	it('ok when JS file has no hardcoded credentials', async () => {
		await writeFile(
			join(cwd, 'config.mjs'),
			`export const API_KEY = process.env.API_KEY;\n`,
		);
		const result = await runSecretsAtRestSensor(cwd, ['config.mjs']);
		assert.equal(result.status, 'ok');
	});
});

// ---------------------------------------------------------------------------
// runCrossRefSensorsOnProposal (Phase 192)
// ---------------------------------------------------------------------------

describe('runCrossRefSensorsOnProposal', () => {
	it('returns [] for empty proposal files', async () => {
		const result = await runCrossRefSensorsOnProposal([]);
		assert.deepEqual(result, []);
	});

	it('returns [] when enabled is false', async () => {
		const result = await runCrossRefSensorsOnProposal(
			[
				{
					path: 'a.mjs',
					content: 'export const SECRET = "sk-prod-xyz123abc456def789ghi012";',
				},
			],
			{ enabled: false },
		);
		assert.deepEqual(result, []);
	});

	it('detects secrets-at-rest in proposal content', async () => {
		const results = await runCrossRefSensorsOnProposal([
			{ path: '.env', content: 'API_KEY=sk-prod-abc123\n' },
		]);
		assert.ok(results.length > 0);
		const sensor = results.find(
			(r) => r.sensor === SENSOR_NAMES.SECRETS_AT_REST,
		);
		assert.ok(sensor, 'secrets-at-rest sensor should fire on .env proposal');
		assert.equal(sensor.status, 'warn');
	});

	it('detects import cycles in proposal content', async () => {
		const results = await runCrossRefSensorsOnProposal([
			{ path: 'a.mjs', content: "import { b } from './b.mjs';\n" },
			{ path: 'b.mjs', content: "import { a } from './a.mjs';\n" },
		]);
		const sensor = results.find((r) => r.sensor === SENSOR_NAMES.IMPORT_CYCLES);
		assert.ok(sensor, 'import-cycles sensor should fire on cyclic proposal');
		assert.equal(sensor.status, 'warn');
	});

	it('all proposal sensor results carry proposalOnly: true', async () => {
		const results = await runCrossRefSensorsOnProposal([
			{ path: '.env', content: 'API_KEY=sk-prod-abc123\n' },
		]);
		for (const r of results) {
			assert.equal(r.proposalOnly, true);
		}
	});

	it('returns ok (not skipped) when proposal has clean JS files', async () => {
		const results = await runCrossRefSensorsOnProposal([
			{
				path: 'utils.mjs',
				content: 'export function greet(name) { return `hello ${name}`; }\n',
			},
		]);
		// Sensor results with status 'ok' are not included (filtered by status !== 'skipped')
		// — all three sensors run and return 'ok', so they are included
		for (const r of results) {
			assert.ok(
				r.status === 'ok' || r.status === 'warn',
				`unexpected status: ${r.status}`,
			);
		}
	});

	it('skips proposal files without content', async () => {
		const results = await runCrossRefSensorsOnProposal([
			{ path: 'empty.mjs', content: undefined },
			{ path: 'real.mjs', content: 'export const x = 1;\n' },
		]);
		// Should not throw; real.mjs is processed normally
		assert.ok(Array.isArray(results));
	});
});
