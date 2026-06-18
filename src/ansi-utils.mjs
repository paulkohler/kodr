// ANSI escape sequence utilities for terminal output.
// visibleWidth / truncateVisible measure and clip strings by their printable
// character count, ignoring ANSI colour/style codes.

// Matches all CSI sequences: ESC [ ... m/K/G/H/F
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/gu;

/**
 * Return the number of visible (printable) characters in `str`, ignoring ANSI
 * escape sequences.
 *
 * @param {string} str
 * @returns {number}
 */
export function visibleWidth(str) {
	return str.replace(ANSI_RE, '').length;
}

/**
 * Truncate `str` to at most `width` visible characters.  Any trailing
 * `ellipsis` (default `''`) is appended and counts against `width`.
 * ANSI sequences that fall before the cut point are preserved in the output;
 * sequences after the cut point are dropped.
 *
 * @param {string} str
 * @param {number} width
 * @param {string} [ellipsis]
 * @returns {string}
 */
export function truncateVisible(str, width, ellipsis = '') {
	if (visibleWidth(str) <= width) return str;
	const targetVisible = width - visibleWidth(ellipsis);
	let visible = 0;
	let result = '';
	let i = 0;
	while (i < str.length) {
		// Try to consume an ANSI sequence starting at position i
		const rest = str.slice(i);
		const m = /^\x1B\[[0-9;]*[A-Za-z]/u.exec(rest);
		if (m) {
			if (visible < targetVisible) {
				result += m[0];
			}
			i += m[0].length;
		} else {
			if (visible >= targetVisible) break;
			result += str[i];
			visible++;
			i++;
		}
	}
	return result + ellipsis;
}
