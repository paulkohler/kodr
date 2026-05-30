Implementation complete. Created three files:

1. `note-linker.mjs` - Main module with:
   - `collectMdFiles()` - recursive directory walker for .md files
   - `extractLinks()` - regex-based wiki link extractor
   - `resolveLinkTarget()` - case-insensitive resolution with .md extension fallback
   - `main(dir)` - the public API returning { links, broken }
   - CLI entry point at bottom

2. `note-linker.test.mjs` - 7 test cases matching requirements:
   - Empty directory
   - Valid link to existing file
   - Broken link to missing file
   - Case-insensitive resolution
   - .md extension omission
   - Mixed valid/broken links
   - Deduplication of broken links

3. `package.json` - ESM-only, no dependencies

Next steps: format, run tests, run check.