# Kodr Usage

This is a practical guide to using `kodr`. It starts with the simplest command
line flows, then builds toward sessions, tools, model comparison, evals, and the
terminal UI.

Kodr is local-first. The default endpoint is LM Studio at
`http://localhost:1234/v1`, the default model is `qwen/qwen3.6-35b-a3b`, and
model calls can take a few minutes.

## Command Line

### Check The Install

```sh
./kodr --help
./kodr --version
npm test
```

Use `./kodr` inside this repo. After `npm run install-local`, use `kodr` from
any workspace.

### Probe The Model

Run a small OpenAI-compatible request against the configured model server:

```sh
./kodr probe
./kodr probe --json
```

By default this talks to LM Studio:

```sh
./kodr probe \
  --base-url http://localhost:1234/v1 \
  --model qwen/qwen3.6-35b-a3b
```

### Dry-Run A Task

Dry-run is the default. Kodr asks the model for a proposal, records artifacts,
and shows what would be written without changing files.

```sh
./kodr run -p "Add a --version flag to the CLI"
./kodr run -p "Add a --version flag to the CLI" --dry-run
```

Useful options:

```sh
./kodr run -p "Refactor the parser" --out .kodr/runs/parser-refactor
./kodr run -p "Refactor the parser" --json
./kodr run --prompt-file prompts/refactor-parser.md
```

### Apply Changes

Pass `--yes` to apply model-proposed writes.

```sh
./kodr run -p "Add tests for parseArgs" --yes
```

Run a verification command after applying:

```sh
./kodr run -p "Add tests for parseArgs" --yes --test "npm test"
./kodr run -p "Fix the example tests" --yes --test "npm test" --test-cwd examples/todo-cli
```

Verification commands are allowlisted and run without a shell. Generated writes
are still treated as untrusted until reviewed.

Use `--protect-existing` when a task should not overwrite committed files:

```sh
./kodr run -p "Create a new example app" --yes --protect-existing
```

### Stream Slow Responses

For local models, streaming makes long calls easier to monitor:

```sh
./kodr run -p "Explain the context packer" --stream
```

### Use Tool Mode

Tool mode lets the model call bounded built-in tools such as file listing,
reading, writing, command execution, task management, and configured MCP-style
tools.

```sh
./kodr run -p "Inspect the CLI and propose a small cleanup" --tools
```

Tool results and failures are written to the run artifacts.

### Control Loop Budgets

Kodr has explicit budgets for long local completions and continuation retries:

```sh
./kodr run -p "Large task" --max-turns 4 --max-retries 2
./kodr run -p "Large task" --max-tokens 20000
./kodr run -p "Large task" --max-cost-usd 0.25
```

Use these when comparing models or running tasks that might drift. Local
providers such as LM Studio and Ollama are treated as `cost: 0`. OpenRouter maps
provider-reported `usage.cost` into Kodr's internal `cost` / `costUsd` fields.
If a future provider does not have a cost mapping, `--max-cost-usd` should fail
instead of silently enforcing the wrong budget.

### Inspect Workspace Context

See which files Kodr would consider:

```sh
./kodr run --show-files
```

Render the packed system context without calling the model:

```sh
./kodr run --show-context
```

Show discovered Markdown skills:

```sh
./kodr run --show-skills
```

Load a specific skill into a run:

```sh
./kodr run -p "Use the project skill to review this task" --skill my-skill
```

Current skill support is Markdown-only from `SKILL.md`. Resource references and
skill code execution are planned as separate later phases.

### Use Inspection-Aware Context

Build a structural index without calling the model:

```sh
./kodr inspect
./kodr inspect --symbol runPrompt
./kodr inspect --symbol runPrompt --json
./kodr inspect --languages js,ts
```

Inspect optional external inspector availability:

```sh
./kodr registry
./kodr registry --json
```

Pack context around relevant symbols, references, imports, and related tests:

```sh
./kodr run -p "Change runPrompt validation" --inspect-context
```

### Continue A Session

Continue the most recent run:

```sh
./kodr run -p "Now add tests for that change" --continue
```

Continue a specific session:

```sh
./kodr run -p "Tighten the error message" --session <session-id>
```

List, show, or export sessions:

```sh
./kodr session list
./kodr session list --json
./kodr session show <session-id>
./kodr session show <session-id> --json
./kodr session export <session-id> --format markdown
```

### Use Scratchpad Context

Inject a previous scratchpad into the next prompt:

```sh
./kodr run -p "Continue the plan" --prior-scratchpad last
./kodr run -p "Continue the plan" --prior-scratchpad .kodr/runs/<id>/scratchpad.md
```

Scratchpad content is capped before entering the prompt.

### Replay And Prompt History

Replay recorded run artifacts without calling a model:

```sh
./kodr replay .kodr/runs/<run-id>
```

Find earlier runs for a prompt id:

```sh
./kodr prompt-history <prompt-id>
./kodr prompt-history <prompt-id> --json
```

Set a prompt id explicitly when running:

```sh
./kodr run --prompt-file prompts/031-markdown-search-core.md --prompt-id markdown-search-core
```

### Compare Models

Run the same prompt against multiple models:

```sh
./kodr compare -p "Generate a small todo CLI" --models "qwen/qwen3.6-35b-a3b,openrouter:openai/gpt-4o-mini"
```

Use OpenRouter directly:

```sh
OPENROUTER_API_KEY=sk-or-... ./kodr run \
  --openrouter \
  --model openai/gpt-4o-mini \
  -p "Review this file"
```

Local flags still override provider defaults:

```sh
./kodr run --base-url http://localhost:1234/v1 --model local-model -p "Task"
```

### Run Evals

Run a structured eval suite:

```sh
./kodr eval --suite evals/todo-cli.json
./kodr eval --suite evals/todo-cli.json --json
```

Eval suites define cases and assertions such as `files_exist`,
`content_matches`, and `tests_pass`. See [evals.md](./evals.md) for suite
format, scoring, examples, and current limitations.

### Cycle Review

Run the cycle-review subagent over a transcript file:

```sh
./kodr cycle-review --transcript-file chat.md
./kodr cycle-review --transcript-file chat.md --json
```

This is useful after a phase or long session to catch process drift, missed user
directions, or AGENTS.md updates that should be considered.

### Serve The Local Channel

Start a dependency-free local HTTP channel:

```sh
./kodr serve
./kodr serve --host 127.0.0.1 --port 8787
```

The server is local-only and routes requests through the same shared channel
used by CLI and TUI flows.

## Terminal UI

Start the line-oriented terminal UI:

```sh
./kodr tui
```

Continue the latest session:

```sh
./kodr tui --continue
```

Open a specific session:

```sh
./kodr tui --session <session-id>
```

The TUI keeps normal user input separate from slash commands. Plain text becomes
a model turn. Slash commands control the session.

### Basic Turn Flow

```text
user> Add a failing test for parseArgs
assistant> working...
assistant> pending review:
  run=.kodr/runs/...
  writes=1
  pending test/app.test.mjs
  commands: /review /accept /reject /test
```

By default, TUI turns dry-run proposed writes. Review them before applying.

### Review And Apply

```text
user> /review
user> /test
user> /accept
```

Commands:

- `/review` reprints the pending write proposal.
- `/test` runs the configured test command for the pending review.
- `/accept` applies the pending review.
- `/reject` discards the pending review.

### Session Commands

```text
user> /sessions
user> /show <session-id>
user> /use <session-id>
user> /new
user> /status
```

Commands:

- `/sessions` lists known sessions.
- `/show <session-id>` prints a compact session transcript.
- `/use <session-id>` sends future turns to that session.
- `/new` starts a new session.
- `/status` shows model, provider, apply mode, tools mode, budgets, last run,
  and pending review state.

### Mode Commands

```text
user> /apply on
user> /apply off
user> /tools on
user> /tools off
user> /model qwen/qwen3.6-35b-a3b
```

Commands:

- `/apply on|off` toggles whether future turns apply writes immediately.
- `/tools on|off` toggles tool mode for future turns.
- `/model <id>` changes the model for future turns.

### Exit

```text
user> /quit
```

`/exit` is also accepted.

## Artifacts

Kodr writes run artifacts under `.kodr/runs/<run-id>/`. Common files include:

- `summary.json`
- `conversation.json`
- `raw-request.json`
- `raw-response.json`
- `context.md`
- `writes.json`
- `tasks.json`
- verification output, when tests run

Use artifacts to debug local model behavior, compare prompts, replay responses,
or write phase blog posts.

## Safety Defaults

- Writes are dry-run unless `--yes` or TUI `/apply on` is used.
- File reads and writes are jailed to the workspace.
- Package locks are listed but not packed into context by default.
- Model output, skills, memory, transcripts, and workspace files are untrusted.
- Verification commands are allowlisted and run without a shell.
- Local model requests default to a long timeout: `600000ms`.
