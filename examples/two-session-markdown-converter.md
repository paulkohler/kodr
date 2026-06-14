# Example Idea: Two-Session Markdown Converter

Build a Markdown-to-HTML converter across two separate kodr sessions to test session
continuation (`kodr continue`). Session 1 builds the core pipeline; Session 2 adds
a CLI and template system by resuming the same session context.

## Areas exercised

- Multi-file generation with real interdependencies (tokenizer → renderer → tests)
- Incremental feature addition without breaking the existing test suite
- Non-trivial Node.js string processing without external libraries
- Session continuation via fresh run + workspace context (see Lessons below)

## Lessons from the 2026-06-15 trial run

### qwen3.6 — Session 1

qwen's response was truncated at 6763 chars. The JSON envelope ended mid-structure
(missing `]}` to close the files array and outer object). R4 (unclosed file object
repair) didn't fire because the file object itself was closed — the array and outer
object were not. R5 (duplicate-key cluster) also couldn't help because the JSON was
syntactically broken. `ProposalMissingError`. **Harness gap: needs a new repair rule
for truncated outer structure (no closing `]}`).**

### devstral — Session 1

3 runs total to get 8/8 tests green:
1. First run: wrote tokenizer.mjs and renderer.mjs only, hit `max_turns=8`, tests
   not yet run.
2. Fix run: wrote test files, tests failed — renderer.test.mjs was missing
   `import assert from 'node:assert'`. The `model:devstral` guidance didn't prevent
   this (the node:test import was present, but the assert import was separate).
3. Targeted fix run: model patched the missing import in one turn. All 8 pass.

**Lesson: increase `--max-turns` to 16+ for 4-file tasks. Default 8 is too tight.**

### Session continuation (--session / --continue)

`--session <id>` and `--continue` both caused empty responses from devstral.
Root cause: the Session 1 run used 24K tokens; loading that history plus the new
prompt exceeded devstral's 32K context window.

**Workaround: run Session 2 as a fresh `kodr run` in the same directory.** The
workspace files provide all the context the model needs — it reads existing source
files automatically via the file-map guide. The Session 2 prompt should describe
what already exists so the model doesn't recreate it.

### Session 2

Fresh run in the existing workspace. devstral wrote all 3 new files (template.mjs,
cli.mjs, cli.test.mjs). Tests passed after one heal cycle. Total: 9/9 green.

The CLI test uses a relative path to spawn cli.mjs. Must run `node --test` from
the project directory (not an absolute path) or the spawned child will look for
cli.mjs in the wrong directory.

## File structure after Session 1

```
src/tokenizer.mjs   — tokenize(markdown): returns array of { type, content } tokens
src/renderer.mjs    — render(tokens): returns HTML string
test/tokenizer.test.mjs
test/renderer.test.mjs
```

## File structure after Session 2

```
src/tokenizer.mjs   (unchanged)
src/renderer.mjs    (unchanged)
src/template.mjs    — applyTemplate(html, meta): wraps in a full HTML document
src/cli.mjs         — reads a .md file from argv, converts, writes .html file
test/tokenizer.test.mjs  (unchanged, must still pass)
test/renderer.test.mjs   (unchanged, must still pass)
test/cli.test.mjs   — spawns cli.mjs as a child process, checks output file
```

## Session 1 prompt

```
Create a Markdown-to-HTML converter in Node.js using only built-in modules.

src/tokenizer.mjs — export function tokenize(markdown). Returns an array of token
objects. Supported token types: heading (with level 1–3), paragraph, code_block
(fenced with ```), list_item (lines starting with - or *), and hr (--- or ***).
Each token is { type: string, content: string, level?: number }.

src/renderer.mjs — export function render(tokens). Converts a token array to an
HTML string. headings → <h1>–<h3>, paragraph → <p>, code_block → <pre><code>,
list items grouped into a single <ul>, hr → <hr>. Escape < > & in content.

test/tokenizer.test.mjs — node:test tests: heading levels, fenced code block,
paragraph, mixed content, horizontal rule.

test/renderer.test.mjs — node:test tests: heading renders to correct tag, code
block gets pre+code, special chars are escaped in paragraphs.

Use ES modules. No npm dependencies.
```

## Session 2 prompt (fresh run in same workspace)

```
The tokenizer and renderer are done and their tests pass. Now add:

src/template.mjs — export function applyTemplate(html, meta) where meta = { title }.
Returns a complete HTML document: <!DOCTYPE html>, <html>, <head> with <title>
and a minimal CSS reset inline, <body> containing the html argument. Escape the
title for HTML.

src/cli.mjs — reads process.argv[2] as a markdown file path, reads it with
node:fs/promises, tokenizes and renders it, applies the template using the
filename (without extension) as the title, writes the result to the same path
with a .html extension (replacing .md). Prints "wrote <outpath>" on success.

test/cli.test.mjs — node:test tests that spawn cli.mjs as a child process using
node:child_process. Write a temporary .md file to os.tmpdir(), run cli.mjs against
it, read back the .html output, and assert it contains <h1> and the title text.
Clean up temp files after each test.

All existing tests must still pass.
```

## What to watch for

- Does Session 2 understand the Session 1 token format without being told explicitly?
- Does it import from the right relative paths in `src/cli.mjs`?
- Do the existing tests still pass after Session 2 adds files?
- Does the model invent a correct `applyTemplate` signature or guess wrong?
- Does the CLI test use absolute paths to avoid CWD-sensitive spawning issues?

## Suggested models

devstral with `--max-turns 20`. qwen3.6 is likely to hit the truncated-envelope
harness gap (no `]}` repair rule) — fix that first before trying qwen on this task.

## Run commands

```sh
# devstral — session 1
mkdir -p ~/src/kodr-testing/md-converter-devstral
cd ~/src/kodr-testing/md-converter-devstral
kodr run --model mistralai/devstral-small-2-2512 --yes --heal --test "node --test" --max-turns 20 -p "<session 1 prompt>"

# devstral — session 2 (fresh run, workspace has the existing files)
kodr run --model mistralai/devstral-small-2-2512 --yes --heal --test "node --test" --max-turns 20 -p "<session 2 prompt>"

# Verify final suite
cd ~/src/kodr-testing/md-converter-devstral && node --test test/*.test.mjs
```

## Results from 2026-06-15 trial (devstral)

| Dimension | devstral |
|-----------|----------|
| Session 1 heal cycles | 2 (wrote 2 files, then targeted fix for missing assert import) |
| Session 2 heal cycles | 1 |
| Final test count | 9/9 |
| Session --continue worked? | No — context window overflow (24K token history) |
| Workaround | Fresh run in same workspace |
