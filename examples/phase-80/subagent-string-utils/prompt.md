Build a tiny Node.js ESM string utility package with native node:test coverage.

Requirements:

- Create `src/string-utils.mjs`.
- Export `slugifyTitle(value)`:
  - accepts a string
  - trims surrounding whitespace
  - lowercases text
  - converts runs of non-alphanumeric characters to single hyphens
  - strips leading and trailing hyphens
  - throws a TypeError for non-string input
- Export `wordCount(value)`:
  - accepts a string
  - counts whitespace-separated words after trimming
  - returns 0 for an empty or whitespace-only string
  - throws a TypeError for non-string input
- Create `test/string-utils.test.mjs` using `node:test` and `node:assert/strict`.
- Create a short `README.md` with usage examples.

reviewer: run `node --test` after implementation and fail the review if tests do not pass.
