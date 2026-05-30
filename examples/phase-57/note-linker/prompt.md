# Note Linker

Write a Node.js 24 ESM program that scans a directory of Markdown files for
wiki-style links (`[[link text]]`) and reports broken links.

## Requirements

- `main(dir)` — async function that takes a directory path, reads all `.md`
  files recursively, and returns a result object
- Result: `{ links: Map<string, string[]>, broken: string[] }`
  - `links`: maps each file path (relative to dir) to an array of link targets
    it contains (the text inside `[[...]]`)
  - `broken`: sorted list of unique link targets that have no matching `.md`
    file in the directory (case-insensitive match, `.md` extension optional
    in the link text)
- CLI: `node note-linker.mjs <dir>` — print broken links one per line, or
  "No broken links." if none
- If the directory does not exist, print an error and exit with code 1
- Ignore non-.md files

## Tests

Write `note-linker.test.mjs` using `node:test` with these cases:

1. Empty directory → no broken links
2. Single file with a link to another file that exists → no broken links
3. Single file with a link to a file that doesn't exist → broken link reported
4. Links are case-insensitive (FileA links to `[[filea]]` which resolves)
5. Link text may omit the `.md` extension (`[[about]]` resolves to `about.md`)
6. Multiple files, some broken some not — only broken ones reported
7. Duplicate broken links across files — deduplicated in output

## Files to produce

- `note-linker.mjs` — the implementation
- `note-linker.test.mjs` — the tests
- `package.json` — `{"type":"module"}` only, no dependencies
