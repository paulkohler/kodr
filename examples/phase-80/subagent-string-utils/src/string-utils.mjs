// src/string-utils.mjs

/**
 * Convert a title to a slug format.
 * @param {string} value - The title string.
 * @returns {string} The slugified title.
 * @throws {TypeError} If the input is not a string.
 */
export function slugifyTitle(value) {
  if (typeof value !== 'string') {
    throw new TypeError('slugifyTitle expects a string');
  }
  // Trim whitespace, lowercase, replace runs of non-alphanumeric chars with hyphen
  const trimmed = value.trim();
  const lowercased = trimmed.toLowerCase();
  const slug = lowercased.replace(/[^a-z0-9]+/g, '-');
  // Remove leading/trailing hyphens
  return slug.replace(/^-+|-+$/g, '');
}

/**
 * Count whitespace-separated words in a string.
 * @param {string} value - The input string.
 * @returns {number} Number of words (0 for empty/whitespace-only).
 * @throws {TypeError} If the input is not a string.
 */
export function wordCount(value) {
  if (typeof value !== 'string') {
    throw new TypeError('wordCount expects a string');
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return 0;
  }
  // Split on one or more whitespace characters
  const words = trimmed.split(/\s+/);
  return words.length;
}