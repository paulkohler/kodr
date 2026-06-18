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

## Results from 2026-06-15 trial with Phase 146 (context window auto-discovery)

Phase 146 probes `/api/v0/models/{id}` on LM Studio for `loaded_context_length`
and scales the context budget accordingly. devstral was loaded at 131072 tokens;
qwen at 262144 tokens.

### devstral Session 1 (Phase 146)

**1 run, no heal cycles.** All 4 files written in a single kodr run:
`src/tokenizer.mjs`, `src/renderer.mjs`, `test/tokenizer.test.mjs`,
`test/renderer.test.mjs`. 20 turns, 93,507 tokens.

`contextWindowSource: 'lmstudio-api'` confirmed in summary.json.
`budgetChars: 262144` (was 80,000 in the trial without Phase 146).

**Improvement vs trial**: 3 separate runs reduced to 1.

### Content-Length fix (HTTP 500 root cause)

In the pre-Phase-146 trial, devstral S2 failed with HTTP 500 on every attempt
(LM Studio log: `SyntaxError: Bad escaped character in JSON at position 620`).
Manual curl replays always returned 200.

**Root cause**: Node.js uses chunked transfer encoding when no `Content-Length`
is set. Multi-turn tool-call history grows the request body to 15–30KB. LM
Studio misparsed the chunked body when a multi-byte UTF-8 character (the em dash
`—` in the system prompt) crossed a chunk boundary.

**Fix**: Set `Content-Length: Buffer.byteLength(bodyText)` in
`src/model-client.mjs`. This forces Node.js to send the full body in one write.
curl sends `Content-Length` by default — why replay worked but kodr didn't.

### devstral Session 2 (Phase 146, fresh run in clean workspace)

**1 run, no 500 error.** Created `src/template.mjs`, `src/cli.mjs`,
`test/cli.test.mjs`. 34 messages, 97,061 tokens.

**Code quality artefacts** (expected — not harness bugs):
- `template.mjs` imports `escapeHtml` from `renderer.mjs`, but `renderer.mjs`
  only exports `render`. Import fails at runtime.
- `cli.test.mjs` hangs: `Promise.all` for `stdout`+`stderr` never resolves when
  no data arrives on one stream. Also uses a wrong relative path
  (`../src/cli.mjs`) that resolves outside the project root.
- Final test score: 8/8 for tokenizer + renderer; cli test suite hangs.

### Session --continue (Phase 146)

Still broken, but for a different reason. S1 history is now only 9,395 chars
(well within 131K) — context overflow is no longer the issue. Instead, S1's
session tail ends with a `repeat:true` sentinel tool result followed by a
0-char empty assistant message. devstral's jinja template enforces strict
role alternation; this tail state triggers: "conversation roles must alternate
user and assistant roles except for tool calls and results."

**Fixed in Phase 147 (commit 4bc1b0d)**: `sanitizeSessionTail` strips the
repeat-sentinel tail before submission; `--continue` now works for devstral.

| Dimension | Trial (no Phase 146) | Phase 146 |
|-----------|----------------------|-----------|
| S1 runs needed | 3 | 1 |
| S1 context budget | 80,000 chars | 262,144 chars |
| S2 HTTP 500 errors | Yes (every attempt) | None |
| S2 code quality | 9/9 tests green | 8/8 (cli test hangs — model bug) |
| --continue worked? | No (context overflow) | No (jinja role alternation) |
