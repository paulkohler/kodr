# Evals

`kodr eval` runs a structured eval suite against a model and scores the results. It is the systematic alternative to reading model output by hand.

## Quick start

```sh
# Run the bundled todo-cli eval against the default local model
./kodr eval --suite evals/todo-cli.json

# Run against a specific model
./kodr eval --suite evals/todo-cli.json --model openrouter:openai/gpt-4o-mini

# Run against OpenRouter (needs OPENROUTER_API_KEY in environment)
OPENROUTER_API_KEY=sk-or-... ./kodr eval --suite evals/todo-cli.json \
  --model openrouter:openai/gpt-4o-mini
```

Results are written to `.kodr/runs/<timestamp>/eval-results.json`.

---

## Suite file format

A suite is a JSON file with a `name`, an optional `description`, and a `cases` array.

```json
{
  "name": "my-suite",
  "description": "What the suite tests",
  "cases": [
    {
      "id": "unique-case-id",
      "prompt": "The prompt sent to the model",
      "assertions": [ ... ]
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Human-readable suite name |
| `description` | no | Longer summary |
| `cases[].id` | yes | Unique identifier for the case |
| `cases[].prompt` | yes | Prompt sent to the model |
| `cases[].model` | no | Override the model for this case |
| `cases[].assertions` | yes | Array of assertion objects (may be empty) |

An empty `assertions` array always scores 1.0 (useful for smoke-testing that a prompt returns without error).

---

## Assertion types

### `files_exist`

Checks that every listed path appears in the proposal's `files` or `patches`.

```json
{
  "type": "files_exist",
  "paths": ["src/cli.mjs", "src/store.mjs", "test/cli.test.mjs"]
}
```

Fails cleanly when the proposal is null (e.g. model returned an empty response).

---

### `content_matches`

Checks that a file's content in the proposal matches a regular expression.

```json
{
  "type": "content_matches",
  "path": "src/cli.mjs",
  "pattern": "commander|yargs|parseArgs"
}
```

Reports a clean error if `pattern` is not a valid regex. Fails if the file is not in the proposal.

---

### `tests_pass`

Writes the proposal files to a temporary directory and runs a command there. Passes only if the command exits with code 0.

```json
{
  "type": "tests_pass",
  "command": "node --test"
}
```

The temp dir is cleaned up after the run (pass or fail). The assertion catches the common pattern of a model generating syntactically correct but logically broken tests — if the generated tests fail, this assertion returns `ok: false`.

**Note on nested `node --test`**: When `kodr eval` itself runs under `node --test` (e.g. in CI), `NODE_TEST_CONTEXT` and `NODE_CHANNEL_FD` are stripped from the child environment before spawning so the grandchild test runner is not treated as a recursive call. Without this, Node.js 24 silently exits 0 instead of running the test files.

---

## Scoring

Each case returns:

| Field | Type | Description |
|---|---|---|
| `ok` | boolean | `true` if every assertion passed |
| `score` | number | `passCount / totalCount` (0–1) |
| `passCount` | number | Assertions that returned `ok: true` |
| `totalCount` | number | Total assertions |
| `assertions` | array | Per-assertion results with `ok` and `detail` |

The suite result adds `passCount` / `totalCount` across all cases.

**Score landmarks**: 0 means the model produced no usable proposal; 0.5 means half the assertions passed; 1.0 means all assertions passed.

---

## Example: todo-cli suite

[`evals/todo-cli.json`](./evals/todo-cli.json) is the bundled example. It has a single case that asks the model to generate a Node.js todo CLI, then checks:

1. Three core files exist (`src/cli.mjs`, `src/store.mjs`, `test/cli.test.mjs`)
2. `src/cli.mjs` contains the word `add`
3. `src/cli.mjs` contains the word `list`
4. `node --test` passes against the generated files

```json
{
  "name": "todo-cli smoke",
  "description": "Smoke-test a model's ability to generate a working Node.js todo CLI",
  "cases": [
    {
      "id": "generates-core-files",
      "prompt": "Build a Node.js 24 ESM CLI todo app with: src/cli.mjs (commander-free, uses node:readline or process.argv), src/store.mjs (JSON file persistence), test/cli.test.mjs (node:test). Commands: add <text>, list, done <id>. No npm dependencies.",
      "assertions": [
        { "type": "files_exist", "paths": ["src/cli.mjs", "src/store.mjs", "test/cli.test.mjs"] },
        { "type": "content_matches", "path": "src/cli.mjs", "pattern": "add" },
        { "type": "content_matches", "path": "src/cli.mjs", "pattern": "list" },
        { "type": "tests_pass", "command": "node --test" }
      ]
    }
  ]
}
```

---

## Output artifacts

```
.kodr/runs/<timestamp>/
  eval-results.json     # suite name, ok, score, per-case results
```

### `eval-results.json` shape

```json
{
  "name": "todo-cli smoke",
  "ok": true,
  "score": 1,
  "passCount": 1,
  "totalCount": 1,
  "timestamp": "...",
  "cases": [
    {
      "id": "generates-core-files",
      "ok": true,
      "score": 1,
      "passCount": 4,
      "totalCount": 4,
      "model": "qwen/qwen3.6-35b-a3b",
      "responseChars": 2841,
      "finishReasons": ["stop"],
      "proposalFound": true,
      "completionError": null,
      "assertions": [
        { "type": "files_exist", "ok": true, "detail": null },
        { "type": "content_matches", "ok": true, "detail": null },
        { "type": "content_matches", "ok": true, "detail": null },
        { "type": "tests_pass", "ok": true, "detail": null }
      ]
    }
  ]
}
```

---

## Known limitations

- **Workspace context**: `kodr eval` uses the same workspace context as `kodr run`. If the eval prompt targets files that already exist in the workspace, the model may return an empty proposal ("code already exists"). A future `--no-context` flag would pass a minimal system prompt for workspace-independent eval cases.
- **Single model per run**: `kodr eval` runs against one model. Use `kodr compare` across models first, then eval the responses separately.
- **No streaming output**: Progress is only visible after each case completes (local models with long context can be slow).
