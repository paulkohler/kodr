import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { visibleWidth, truncateVisible } from '../src/ansi-utils.mjs';

const RED = '\x1B[31m';
const RESET = '\x1B[0m';
const BOLD = '\x1B[1m';

describe('visibleWidth', () => {
	it('returns length of plain string', () => {
		assert.equal(visibleWidth('hello'), 5);
	});

	it('ignores ANSI colour codes', () => {
		assert.equal(visibleWidth(`${RED}hello${RESET}`), 5);
	});

	it('ignores bold and other SGR codes', () => {
		assert.equal(visibleWidth(`${BOLD}world${RESET}`), 5);
	});

	it('handles string with only escape sequences', () => {
		assert.equal(visibleWidth(`${RED}${RESET}`), 0);
	});

	it('handles empty string', () => {
		assert.equal(visibleWidth(''), 0);
	});
});

describe('truncateVisible', () => {
	it('returns string unchanged when within width', () => {
		assert.equal(truncateVisible('hello', 10), 'hello');
	});

	it('truncates plain string to width', () => {
		assert.equal(truncateVisible('hello world', 5), 'hello');
	});

	it('appends ellipsis and counts it against width', () => {
		// width=8, ellipsis=1 → 7 visible chars + '…' = 8 total visible
		assert.equal(truncateVisible('hello world', 8, '…'), 'hello w…');
	});

	it('preserves ANSI codes before the cut point', () => {
		const coloured = `${RED}hello${RESET} world`;
		const result = truncateVisible(coloured, 5);
		// visible part is "hello"; ANSI codes before it must be preserved
		assert.equal(visibleWidth(result), 5);
		assert.ok(result.includes(RED));
	});

	it('does not include ANSI codes after the cut point', () => {
		// ANSI reset comes after the cut — should not appear in output
		const str = `hello${RESET} world`;
		const result = truncateVisible(str, 5);
		assert.ok(!result.includes(RESET));
	});

	it('handles string consisting entirely of escape sequences before content', () => {
		const str = `${RED}${BOLD}hi${RESET}`;
		assert.equal(truncateVisible(str, 1), `${RED}${BOLD}h`);
	});

	it('truncates mid-ANSI correctly when width is 0', () => {
		const result = truncateVisible(`${RED}hello${RESET}`, 0);
		assert.equal(result, '');
	});
});
