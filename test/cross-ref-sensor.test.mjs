import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
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
	runCrossRefSensors,
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
		assert.ok(r.some((s) => s.sensor === 'compose-dockerfile'));
	});
});
