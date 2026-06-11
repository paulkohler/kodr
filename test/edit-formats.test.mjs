import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	normalizeEditFormat,
	renderEditFormatContract,
	extractEditBlocks,
	mergeBlockPatches,
} from '../src/edit-formats.mjs';

// ---------------------------------------------------------------------------
// normalizeEditFormat
// ---------------------------------------------------------------------------

describe('normalizeEditFormat', () => {
	it("returns 'patch' for 'patch'", () => {
		assert.equal(normalizeEditFormat('patch'), 'patch');
	});

	it("returns 'whole' for 'whole'", () => {
		assert.equal(normalizeEditFormat('whole'), 'whole');
	});

	it("returns 'blocks' for 'blocks'", () => {
		assert.equal(normalizeEditFormat('blocks'), 'blocks');
	});

	it("returns 'patch' for null", () => {
		assert.equal(normalizeEditFormat(null), 'patch');
	});

	it("returns 'patch' for undefined", () => {
		assert.equal(normalizeEditFormat(undefined), 'patch');
	});

	it("returns 'patch' for empty string", () => {
		assert.equal(normalizeEditFormat(''), 'patch');
	});

	it("returns 'patch' for an unknown string", () => {
		assert.equal(normalizeEditFormat('invalid'), 'patch');
	});

	it("returns 'patch' for a number", () => {
		assert.equal(normalizeEditFormat(123), 'patch');
	});
});

// ---------------------------------------------------------------------------
// renderEditFormatContract
// ---------------------------------------------------------------------------

describe('renderEditFormatContract', () => {
	it("'patch': starts with 'You are Kodr'", () => {
		assert.match(renderEditFormatContract('patch'), /^You are Kodr/u);
	});

	it("'patch': contains 'patches'", () => {
		assert.ok(renderEditFormatContract('patch').includes('patches'));
	});

	it("'patch': contains 'search'", () => {
		// The patch contract mentions search text must match
		assert.ok(
			renderEditFormatContract('patch').toLowerCase().includes('search'),
		);
	});

	it("'whole': starts with 'You are Kodr'", () => {
		assert.match(renderEditFormatContract('whole'), /^You are Kodr/u);
	});

	it("'whole': contains full-file write language", () => {
		const text = renderEditFormatContract('whole');
		// The whole contract talks about full-file writes
		assert.ok(
			text.includes('full-file writes') ||
				text.includes('complete file content'),
		);
	});

	it("'whole': does NOT contain 'search text must match'", () => {
		assert.ok(
			!renderEditFormatContract('whole').includes('search text must match'),
		);
	});

	it("'blocks': starts with 'You are Kodr'", () => {
		assert.match(renderEditFormatContract('blocks'), /^You are Kodr/u);
	});

	it("'blocks': contains 'SEARCH/REPLACE'", () => {
		assert.ok(renderEditFormatContract('blocks').includes('SEARCH/REPLACE'));
	});

	it("'blocks': contains '<<<<<<< SEARCH'", () => {
		assert.ok(renderEditFormatContract('blocks').includes('<<<<<<< SEARCH'));
	});

	it('default (no argument): same as patch', () => {
		assert.equal(renderEditFormatContract(), renderEditFormatContract('patch'));
	});

	it('default (undefined): same as patch', () => {
		assert.equal(
			renderEditFormatContract(undefined),
			renderEditFormatContract('patch'),
		);
	});

	it("renderEditFormatContract('patch') is byte-identical to renderEditFormatContract()", () => {
		const withArg = renderEditFormatContract('patch');
		const withoutArg = renderEditFormatContract();
		// Same reference value via strict equality
		assert.equal(withArg, withoutArg);
	});
});

// ---------------------------------------------------------------------------
// extractEditBlocks — helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal SEARCH/REPLACE block string.
 *
 * @param {string} path
 * @param {string} search
 * @param {string} replace
 * @returns {string}
 */
function makeBlock(path, search, replace) {
	return [
		path,
		'<<<<<<< SEARCH',
		search,
		'=======',
		replace,
		'>>>>>>> REPLACE',
	].join('\n');
}

// ---------------------------------------------------------------------------
// extractEditBlocks
// ---------------------------------------------------------------------------

describe('extractEditBlocks', () => {
	// --- happy path ---

	it('single block: parses path, search, and replace correctly', () => {
		const text = makeBlock('src/foo.js', 'old line', 'new line');
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 1);
		assert.equal(patches[0].path, 'src/foo.js');
		assert.equal(patches[0].search, 'old line');
		assert.equal(patches[0].replace, 'new line');
	});

	it('multiple blocks for the same file: returns multiple patches', () => {
		const block1 = makeBlock('src/app.js', 'alpha', 'ALPHA');
		const block2 = makeBlock('src/app.js', 'beta', 'BETA');
		const text = `${block1}\n\n${block2}`;
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 2);
		assert.equal(patches[0].path, 'src/app.js');
		assert.equal(patches[1].path, 'src/app.js');
		assert.equal(patches[0].search, 'alpha');
		assert.equal(patches[1].search, 'beta');
	});

	it('multiple blocks for different files: returns patches with correct paths', () => {
		const block1 = makeBlock('src/a.js', 'foo', 'bar');
		const block2 = makeBlock('src/b.ts', 'baz', 'qux');
		const text = `${block1}\n\n${block2}`;
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 2);
		assert.equal(patches[0].path, 'src/a.js');
		assert.equal(patches[1].path, 'src/b.ts');
	});

	it('fenced wrapping: block inside ``` code fence is parsed', () => {
		const text = [
			'```',
			'src/foo.js',
			'<<<<<<< SEARCH',
			'old code',
			'=======',
			'new code',
			'>>>>>>> REPLACE',
			'```',
		].join('\n');
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 1);
		assert.equal(patches[0].path, 'src/foo.js');
	});

	it('CRLF normalization: \\r\\n in input is handled correctly', () => {
		const text = [
			'src/foo.js',
			'<<<<<<< SEARCH',
			'old',
			'=======',
			'new',
			'>>>>>>> REPLACE',
		].join('\r\n');
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 1);
		assert.equal(patches[0].search, 'old');
		assert.equal(patches[0].replace, 'new');
	});

	it('path with backticks: strips backticks from path', () => {
		const text = [
			'`src/bar.js`',
			'<<<<<<< SEARCH',
			'old',
			'=======',
			'new',
			'>>>>>>> REPLACE',
		].join('\n');
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 1);
		assert.equal(patches[0].path, 'src/bar.js');
	});

	// --- error cases: errors returned, not thrown ---

	it('missing path line → error entry, not a throw', () => {
		// Put two blank lines before <<<<<<< SEARCH so there's no path
		const text = [
			'',
			'',
			'<<<<<<< SEARCH',
			'old',
			'=======',
			'new',
			'>>>>>>> REPLACE',
		].join('\n');
		assert.doesNotThrow(() => extractEditBlocks(text));
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(patches.length, 0);
		assert.ok(errors.length > 0);
		assert.ok(
			errors.some((e) => e.reason.toLowerCase().includes('missing path line')),
		);
	});

	it('missing ======= separator → error entry, not a throw', () => {
		// No ======= line between SEARCH and REPLACE
		const text = [
			'src/foo.js',
			'<<<<<<< SEARCH',
			'old',
			'>>>>>>> REPLACE',
		].join('\n');
		assert.doesNotThrow(() => extractEditBlocks(text));
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(patches.length, 0);
		assert.ok(errors.length > 0);
		assert.ok(
			errors.some((e) => e.reason.toLowerCase().includes('missing =======')),
		);
	});

	it('missing >>>>>>> REPLACE marker → error entry, not a throw', () => {
		const text = ['src/foo.js', '<<<<<<< SEARCH', 'old', '=======', 'new'].join(
			'\n',
		);
		assert.doesNotThrow(() => extractEditBlocks(text));
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(patches.length, 0);
		assert.ok(errors.length > 0);
		assert.ok(
			errors.some((e) => e.reason.toLowerCase().includes('missing >>>>>>>')),
		);
	});

	it('empty search content → error entry', () => {
		// Path present, no content between SEARCH and =======
		const text = [
			'src/foo.js',
			'<<<<<<< SEARCH',
			'=======',
			'new',
			'>>>>>>> REPLACE',
		].join('\n');
		assert.doesNotThrow(() => extractEditBlocks(text));
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(patches.length, 0);
		assert.ok(errors.length > 0);
		assert.ok(
			errors.some((e) => e.reason.toLowerCase().includes('empty search')),
		);
	});

	it('non-string input → error entry, not a throw', () => {
		assert.doesNotThrow(() => extractEditBlocks(42));
		const { patches, errors } = extractEditBlocks(42);
		assert.equal(patches.length, 0);
		assert.ok(errors.length > 0);
	});

	it('no blocks in text → empty patches and empty errors', () => {
		const { patches, errors } = extractEditBlocks(
			'Hello world, no blocks here.',
		);
		assert.equal(patches.length, 0);
		assert.equal(errors.length, 0);
	});

	it('mixed valid and invalid blocks → valid ones in patches, invalid in errors', () => {
		// Valid block
		const validBlock = makeBlock('src/valid.js', 'before', 'after');
		// Invalid block: missing ======= separator
		const invalidBlock = ['src/bad.js', '<<<<<<< SEARCH', 'old'].join('\n');
		const text = `${validBlock}\n\n${invalidBlock}`;
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(patches.length, 1);
		assert.equal(patches[0].path, 'src/valid.js');
		assert.ok(errors.length > 0);
	});

	it('content after last block is ignored', () => {
		const block = makeBlock('src/foo.js', 'old', 'new');
		const text = `${block}\n\nSome trailing content that is not a block.`;
		const { patches, errors } = extractEditBlocks(text);
		assert.equal(errors.length, 0);
		assert.equal(patches.length, 1);
	});
});

// ---------------------------------------------------------------------------
// mergeBlockPatches
// ---------------------------------------------------------------------------

describe('mergeBlockPatches', () => {
	it('appends block patches to existing proposal patches', () => {
		const proposal = {
			status: 'OK',
			patches: [{ path: 'a.js', search: 'x', replace: 'y' }],
		};
		const blocks = {
			patches: [{ path: 'b.js', search: 'm', replace: 'n' }],
		};
		const result = mergeBlockPatches(proposal, blocks);
		assert.equal(result.patches.length, 2);
		assert.equal(result.patches[0].path, 'a.js');
		assert.equal(result.patches[1].path, 'b.js');
	});

	it('does not mutate the original proposal', () => {
		const original = [{ path: 'a.js', search: 'x', replace: 'y' }];
		const proposal = { status: 'OK', patches: original };
		const blocks = { patches: [{ path: 'b.js', search: 'm', replace: 'n' }] };
		mergeBlockPatches(proposal, blocks);
		assert.equal(proposal.patches.length, 1);
		assert.equal(proposal.patches, original);
	});

	it('empty blocks → original proposal patches unchanged in result', () => {
		const proposal = {
			status: 'OK',
			patches: [{ path: 'a.js', search: 'x', replace: 'y' }],
		};
		const blocks = { patches: [] };
		const result = mergeBlockPatches(proposal, blocks);
		assert.equal(result.patches.length, 1);
		assert.equal(result.patches[0].path, 'a.js');
	});

	it('proposal with no patches field → creates patches array from blocks', () => {
		const proposal = { status: 'OK' };
		const blocks = { patches: [{ path: 'b.js', search: 'm', replace: 'n' }] };
		const result = mergeBlockPatches(proposal, blocks);
		assert.equal(result.patches.length, 1);
		assert.equal(result.patches[0].path, 'b.js');
	});
});

// ---------------------------------------------------------------------------
// blocks-in-app-flow integration: extractEditBlocks + mergeBlockPatches
// ---------------------------------------------------------------------------

describe('blocks-in-app-flow integration', () => {
	it('proposal with empty patches + text with blocks → merged result has those patches', () => {
		// Simulate what app.mjs does after extractProposal when editFormat==='blocks':
		// the JSON envelope has empty patches, but the raw text contains SEARCH/REPLACE blocks.
		const proposal = {
			status: 'OK',
			messages: [],
			files: [],
			patches: [],
			scratchpad: '',
		};
		const rawText = [
			JSON.stringify(proposal),
			'',
			'src/index.js',
			'<<<<<<< SEARCH',
			'const x = 1;',
			'=======',
			'const x = 2;',
			'>>>>>>> REPLACE',
		].join('\n');

		const blocks = extractEditBlocks(rawText);
		assert.equal(blocks.errors.length, 0);
		assert.equal(blocks.patches.length, 1);

		const merged = mergeBlockPatches(proposal, blocks);
		assert.equal(merged.patches.length, 1);
		assert.equal(merged.patches[0].path, 'src/index.js');
		assert.equal(merged.patches[0].search, 'const x = 1;');
		assert.equal(merged.patches[0].replace, 'const x = 2;');
		// Original proposal was not mutated
		assert.equal(proposal.patches.length, 0);
	});

	it('block errors are recorded in proposal._blockErrors', () => {
		// Simulate a malformed block: missing ======= separator
		const proposal = {
			status: 'OK',
			messages: [],
			files: [],
			patches: [],
			scratchpad: '',
		};
		const rawText = [
			JSON.stringify(proposal),
			'',
			'src/bad.js',
			'<<<<<<< SEARCH',
			'old line',
			// intentionally missing ======= and >>>>>>> REPLACE
		].join('\n');

		const blocks = extractEditBlocks(rawText);
		// Should have an error for the malformed block
		assert.ok(blocks.errors.length > 0);
		assert.equal(blocks.patches.length, 0);

		// Simulate what app.mjs does: record errors in _blockErrors
		const result = { ...proposal };
		if (blocks.patches.length > 0) {
			Object.assign(result, mergeBlockPatches(proposal, blocks));
		}
		if (blocks.errors.length > 0) {
			result._blockErrors = blocks.errors;
		}

		assert.ok(Array.isArray(result._blockErrors));
		assert.ok(result._blockErrors.length > 0);
		// patches remain empty since no valid block was found
		assert.equal(result.patches.length, 0);
	});

	it('multiple valid blocks → all appended to empty patches', () => {
		const proposal = { status: 'OK', patches: [], files: [] };
		const rawText = [
			makeBlock('src/a.js', 'foo', 'bar'),
			'',
			makeBlock('src/b.js', 'baz', 'qux'),
		].join('\n');

		const blocks = extractEditBlocks(rawText);
		assert.equal(blocks.errors.length, 0);
		assert.equal(blocks.patches.length, 2);

		const merged = mergeBlockPatches(proposal, blocks);
		assert.equal(merged.patches.length, 2);
		assert.equal(merged.patches[0].path, 'src/a.js');
		assert.equal(merged.patches[1].path, 'src/b.js');
	});

	it('proposal already has patches → blocks are appended after existing patches', () => {
		const existingPatch = {
			path: 'src/existing.js',
			search: 'old',
			replace: 'new',
		};
		const proposal = { status: 'OK', patches: [existingPatch] };
		const rawText = makeBlock('src/added.js', 'x', 'y');

		const blocks = extractEditBlocks(rawText);
		const merged = mergeBlockPatches(proposal, blocks);
		assert.equal(merged.patches.length, 2);
		assert.equal(merged.patches[0].path, 'src/existing.js');
		assert.equal(merged.patches[1].path, 'src/added.js');
	});
});
