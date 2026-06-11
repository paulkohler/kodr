import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as repomap from '../src/repomap/index.mjs';

const EXPECTED_EXPORTS = new Set([
	'listContextFiles',
	'looksBinary',
	'readTextPrefix',
	'classifyLanguage',
	'findReferences',
	'inspectFile',
	'inspectWorkspace',
	'rankSymbols',
	'buildInspectionChunks',
	'matchingSymbols',
	'queryTokens',
	'selectInspectionChunks',
	'buildFileMap',
	'buildFileSummaries',
	'renderFileMapText',
	'renderInspectionSummary',
]);

describe('repomap entry-point surface', () => {
	it('exports exactly the documented public API', () => {
		const actual = new Set(Object.keys(repomap));
		const extra = [...actual].filter((name) => !EXPECTED_EXPORTS.has(name));
		const missing = [...EXPECTED_EXPORTS].filter((name) => !actual.has(name));

		assert.deepEqual(
			extra,
			[],
			`unexpected exports added to the public surface: ${extra.join(', ')}`,
		);
		assert.deepEqual(
			missing,
			[],
			`documented exports missing from the public surface: ${missing.join(', ')}`,
		);
	});

	it('all exported values are functions', () => {
		for (const [name, value] of Object.entries(repomap)) {
			assert.equal(typeof value, 'function', `${name} should be a function`);
		}
	});
});
