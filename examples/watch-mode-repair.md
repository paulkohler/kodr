# Example Idea: Watch Mode Repair Loop

Run `kodr watch` against a file with a deliberate bug, trigger the watcher by saving
the file, then use the Phase 142 accept/reject prompt to decide whether to apply the
repair. Tests the interactive watcher path end-to-end.

## Areas exercised

- `kodr watch` watcher mode (Phase 107)
- Accept/reject prompt after repair proposal (Phase 142)
- Heal loop driven by real test failure, not a manufactured eval fixture
- TTY interaction: does the prompt feel natural? Is the diff readable?
- Non-trivial repair: the bug should require a multi-line fix, not a one-liner

## Setup

Create a small project with a passing test suite, then introduce a bug:

```
src/parser.mjs   — parse(input): splits a CSV line into fields, handles quoted fields
test/parser.test.mjs — node:test suite (start with all passing)
```

The deliberate bug: remove the quote-handling branch so `parse('"hello,world",foo')`
returns `['"hello', 'world"', 'foo']` instead of `['hello,world', 'foo']`.

## Session flow

1. Generate the project with kodr (or hand-write a passing version).
2. Introduce the bug manually.
3. Run `kodr watch --test "node --test"` in the project directory.
4. The watcher should detect the change, run tests, see a failure, and propose a repair.
5. Review the diff and accept or reject at the prompt.
6. Re-run tests manually to confirm the repair worked.

## Suggested prompt for the seed project

```
Create a CSV line parser in Node.js.

src/parser.mjs — export function parse(line): splits a CSV-format line into an
array of fields. Handles quoted fields that may contain commas. A field enclosed
in double-quotes has the quotes stripped; commas inside quotes are not field
separators. Unquoted fields are split on comma. No external dependencies.

test/parser.test.mjs — node:test tests covering: simple comma-split, quoted field
with comma inside, empty fields, mixed quoted and unquoted.
```

After generation, manually introduce the bug by deleting or commenting out the
quote-handling branch in `src/parser.mjs`.

## What to watch for

- Does the watcher fire promptly after the file save?
- Is the proposed diff minimal (just restoring the quote branch)?
- Does the accept prompt display clearly in the terminal?
- After accepting, does `node --test` go green?
- What happens if you reject? Does the watcher continue watching?

## Suggested models

Any model works for the seed generation. devstral or qwen3.6 for the repair run.
The interesting observation is the quality and size of the repair diff.

## Run command

```sh
mkdir -p ~/src/kodr-testing/watch-repair
cd ~/src/kodr-testing/watch-repair
kodr run -p "..." --model qwen/qwen3.6-35b-a3b
# introduce bug manually
kodr watch --test "node --test"
```
