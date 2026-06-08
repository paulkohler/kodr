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

`--model` also accepts provider/model specs. Kodr splits only the first slash,
so provider-native model ids can keep their own slashes:

```sh
./kodr run -p "Say hello" --model lmstudio/qwen/qwen3.6-35b-a3b
./kodr run -p "Say hello" --model openrouter/openai/gpt-4o-mini
```

Kodr resolves the active model through a local profile registry. Profiles set
defaults for context window, completion reserve, timeout, tool-call support, and
response-envelope behavior. Override or add profiles with
`.kodr/model-profiles.json`, or point `KODR_MODEL_PROFILES` at a JSON file.
Explicit flags such as `--timeout-ms` and `--session-context-chars` still win.

Context packing uses the active profile's context window minus the completion
reserve to decide how much workspace context to include. Override those values
for a run when the serving layer has a different loaded context size:

```sh
./kodr run -p "Inspect the API" \
  --context-window 65536 \
  --completion-reserve 4096
```

The packed context summary records the active window, reserve, estimated budget,
packed chars, and dropped inspection chunks when a budget forces omissions.

For subagent orchestration, override individual agent models with repeatable
`--agent-model` flags:

```sh
./kodr run -p "Implement the feature" --subagent-stages \
  --model lmstudio/qwen/qwen3.6-35b-a3b \
  --agent-model planner=openrouter/anthropic/claude-opus \
  --agent-model reviewer=lmstudio/nvidia/nemotron-3-nano-omni
```

Supported subagent names are `planner`, `implementer`, and `reviewer`. Plain
`--model qwen/qwen3.6-35b-a3b` and `--openrouter --model openai/gpt-4o-mini`
remain supported. `--agent-model` only applies when `--subagent-stages` is set;
normal runs use the primary `--model`.

Prompt caching is enabled by default for supported remote model ids:

```sh
./kodr run -p "Review the repo" --model openrouter/anthropic/claude-sonnet-4.5
./kodr run -p "Review the repo" --model openrouter/anthropic/claude-sonnet-4.5 --prompt-cache off
```

In `auto` mode, Anthropic model ids receive root
`cache_control: { "type": "ephemeral" }`. OpenAI, DeepSeek, Gemini, Qwen, and
other remote models are report-only in this phase: Kodr does not send explicit
cache controls, but records cache usage fields when the provider returns them.
Local LM Studio and non-cloud Ollama models do not receive prompt cache fields.
Ollama model ids ending in `:cloud` are treated as remote for usage/cost
assumptions, but still do not receive provider-specific cache controls unless a
future adapter supports that model.

Subagent stages use isolated conversations with compact handoffs. The planner
passes a plan to the implementer once, Kodr applies the proposal, then Kodr runs
requested dependency installation and verification before the reviewer starts.
The reviewer receives a write manifest and verification result and reads only
the files it needs to inspect.

When the plan names several target files, Kodr drives the implementer
file-by-file: it parses the planned file paths into a manifest, and if the
first proposal omits some of them it re-prompts the implementer for the missing
files (bounded passes, stopping when the manifest is satisfied or a pass adds
nothing) and merges the results. This suits small local models that cannot emit
a whole multi-file project in one response. `orchestration.json` records the
implementer `manifestCount` and any `missingFiles`.

The reviewer stage is advisory; deterministic verification is authoritative. A
reviewer model error or timeout is recorded as "reviewer unavailable" and does
not fail the run or discard applied writes. The reviewer also fails fast: its
model timeout defaults to `min(--timeout-ms, 180000)` so a slow local reviewer
cannot tie up a run for the full timeout. Override it with `--review-timeout-ms`,
or skip the stage entirely with `--no-review`:

```sh
./kodr run -p "Implement the feature" --subagent-stages --yes --no-review
./kodr run -p "Implement the feature" --subagent-stages --yes --review-timeout-ms 60000
```

`--heal` also applies to subagent runs: if verification fails after the
implementer's writes, Kodr runs the same bounded repair loop used by normal
runs, driven by the primary `--model` (the implementer). The active
`--prompt-file` is always protected from being written — it is a run input, so
proposals that try to recreate or edit it are dropped and recorded under
`writes.json` `protected` rather than applied.

```sh
./kodr run -p "Implement the feature" --subagent-stages \
  --yes \
  --install \
  --test "npm test"
```

If `npm test` is requested for a generated native Node test suite that has no
`package.json`, Kodr records the requested command and resolves verification to
`node --test` instead of allowing npm to search a parent project.

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

Install dependencies before verification when a generated project adds or
changes `package.json`:

```sh
./kodr run --prompt-file prompt.md --tools --yes --install --test "npm test"
./kodr run --prompt-file prompt.md --tools --yes --install --test "npm test" --test-cwd examples/app
```

Dependency installs are a separate allowlisted workflow. Kodr runs `npm ci`
when `package-lock.json` exists, otherwise `npm install`, and records the result
in `install.json`. Because `npm ci` is strict — it refuses when the lockfile is
out of sync with `package.json`, which happens easily when a generated
`package.json` lands over a stale lock — Kodr automatically falls back to
`npm install` (which regenerates the lock) if the auto-chosen `npm ci` fails.
`install.json` records `fallbackFrom` and `fallbackReason` when this happens.

### Run Commands In Docker

Use `--docker-sandbox` to run dependency installs, verification, and built-in
command tools inside a Docker container with the current workspace mounted at
`/workspace`.

```sh
./kodr run --prompt-file prompt.md --tools --yes --docker-sandbox --test "npm test"
./kodr run --prompt-file prompt.md --tools --yes --docker-sandbox --install --test "npm test"
```

Sandbox defaults are intentionally narrow:

```sh
./kodr run -p "Verify this project" --yes --docker-sandbox --docker-network none
./kodr run -p "Install and test" --yes --docker-sandbox --install --docker-network bridge
./kodr run -p "Debug a failing run" --yes --docker-sandbox --docker-keep --test "npm test"
```

`--docker-sandbox` alone uses `--network none`. With `--install`, Kodr defaults
to `bridge` so npm can reach the package registry unless you override it. The
model call and artifact writes still happen on the host; command effects run in
Docker. `docker.json` records the image, network, mount, kept container names,
and inspection commands.

### Run Commands In OpenShell

Use `--openshell-sandbox` when a compatible NVIDIA OpenShell CLI and a selected
local gateway are available. Kodr uploads a filtered workspace snapshot, then
runs dependency installs, verification, built-in command tools, and command
hooks inside one persistent OpenShell sandbox.

```sh
./kodr run --prompt-file prompt.md --tools --yes --openshell-sandbox --test "npm test"
./kodr run --prompt-file prompt.md --tools --yes --openshell-sandbox --openshell-policy ./openshell-policy.yaml --install --test "npm test"
./kodr run -p "Debug a failing run" --yes --openshell-sandbox --openshell-keep --test "npm test"
```

OpenShell sandboxing is deliberately strict:

- Kodr requires the `sandbox create`, `sandbox exec`, `sandbox upload`, and
  `sandbox delete` command surfaces.
- The selected gateway must be running on a loopback address. Remote gateways
  are refused because they would receive workspace files.
- `--install` requires an explicit `--openshell-policy` file.
- Without an explicit policy, Kodr creates a default-deny policy for the run.
- `.git`, `.kodr`, `node_modules`, private memory, environment secret files,
  and common package-manager or user credential files are excluded from the
  upload snapshot.
- Files are synchronized to exact paths under `/sandbox`; stale uploaded files
  are removed while sandbox-only dependency state is preserved.
- Command-created files remain in the sandbox. Kodr does not download arbitrary
  sandbox changes over the host workspace.
- The sandbox is deleted after the run unless `--openshell-keep` is present.

`openshell.json` records capability failures, gateway metadata, policy choice,
workspace synchronization, command execution, and sandbox lifecycle. Kodr never
silently falls back to Docker or host execution when `--openshell-sandbox` is
requested.

### Run Kodr In OpenShell

Use `--openshell-worker` when the harness itself should run inside OpenShell.
This is stronger than `--openshell-sandbox`: the host Kodr process creates the
sandbox, uploads the workspace and Kodr runtime, runs a nested Kodr command
inside `/sandbox`, then downloads only the nested `.kodr/worker-run` artifacts.

```sh
./kodr run \
  --prompt-file prompt.md \
  --openshell-worker \
  --yes \
  --install \
  --test "npm test"
```

Worker mode is mutually exclusive with `--docker-sandbox` and
`--openshell-sandbox`. It does not write arbitrary sandbox filesystem changes
back over the host checkout. Future phases can add reviewed diff/writeback and a
host-owned model relay for remote provider keys.

Ask Kodr to run a bounded repair loop after failed verification:

```sh
./kodr run --prompt-file prompt.md --tools --yes --install --test "npm test" --heal
```

Repair turns receive the failing `tests.json` output plus the failing file and
nearby source. They write artifacts under `repairs/` and stop on success,
repeated no-progress, wrong-path edits, budget exhaustion, or timeout.

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

### Enable Command Hooks

Command hooks are opt-in. Use them when you want deterministic scripts around
tool use or final stopping decisions:

```sh
./kodr run -p "Inspect and update tests" --tools --hooks
./kodr run -p "Inspect and update tests" --tools --hooks --hooks-config .kodr/hooks.json
```

Kodr reads `.kodr/hooks.json` by default. Hook commands run without a shell,
receive JSON on stdin, and are recorded in `hooks.json`. Each recorded run notes
its execution `environment`. Hooks run on the host cwd by default; when
`--docker-sandbox` or `--openshell-sandbox` is enabled, hook commands run inside
the active sandbox so they share the install/test/tool environment, and
`hooks.json` reports the selected execution environment.

Hooks fire at these points in the model loop:

1. `AgentStart` — before a standard model call starts. A block prevents token
   generation.
2. `SubagentStart` — before a planner, implementer, or reviewer subagent starts.
   A block prevents that subagent model call.
3. `PreToolUse` — before a native tool effect runs. A block prevents the effect.
4. `PostToolUse` — after a tool effect succeeds. Audit/feedback only; it cannot
   prevent the effect that already ran.
5. `Stop` — after the assistant's final response and before Kodr ends the model
   loop. A block forces another model turn.

Post-apply/post-run final checks (lint or tests against the applied workspace)
are intentionally not a hook yet; Stop runs before proposal writes are applied,
so it is a model-loop guard, not a post-apply verifier. See
`process/decisions.jsonl` for the deferral rationale.

Example `PreToolUse` guard. This blocks the tool effect before it runs when the
command matches:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["scripts/guard-command.mjs"],
            "if": "run_command(rm *)"
          }
        ]
      }
    ]
  }
}
```

A `PreToolUse` hook that prints `{"decision":"block","reason":"..."}` (or exits
non-zero) stops the tool from running and reports the reason back to the model.

Example `SubagentStart` logger. Matchers use the agent name (`planner`,
`implementer`, `reviewer`, or `standard` for `AgentStart`):

```json
{
  "hooks": {
    "SubagentStart": [
      {
        "matcher": "planner",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["scripts/log-subagent-start.mjs"]
          }
        ]
      }
    ]
  }
}
```

Example `PostToolUse` logger. This observes after the tool succeeds; it cannot
prevent the tool effect:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "run_command",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["scripts/log-tool-use.mjs"]
          }
        ]
      }
    ]
  }
}
```

Example `Stop` hook that can force another model turn before Kodr accepts the
assistant's final response:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["scripts/stop-check.mjs"]
          }
        ]
      }
    ]
  }
}
```

If the Stop hook prints this JSON, Kodr feeds the reason back into the chat and
continues until the hook allows stopping or the turn budget is exhausted:

```json
{"decision":"block","reason":"npm test failed"}
```

Stop hooks fire before normal proposal writes are applied. Use them as
model-loop guards, not as final post-apply verification.

### Control Loop Budgets

Kodr has explicit budgets for long local completions and continuation retries:

```sh
./kodr run -p "Large task" --max-turns 4 --max-retries 2
./kodr run -p "Large task" --max-tokens 20000
./kodr run -p "Large task" --max-cost-usd 0.25
./kodr run -p "Large task" --max-thinking-tokens 4096
```

Use these when comparing models or running tasks that might drift. Local
providers such as LM Studio and Ollama are treated as `cost: 0`. OpenRouter maps
provider-reported `usage.cost` into Kodr's internal `cost` / `costUsd` fields.
If a future provider does not have a cost mapping, `--max-cost-usd` should fail
instead of silently enforcing the wrong budget.

`--max-thinking-tokens` is an opt-in request parameter for reasoning models and
servers that accept `max_thinking_tokens`. Kodr leaves it unset by default so
strict OpenAI-compatible local servers are not sent unknown fields.

Prompt cache counters are folded into usage summaries when providers report
them. `cached` means tokens read from a cache, while `cache write` means tokens
used to establish a cache entry. OpenRouter's `usage.cost` remains the
authoritative cost value.

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

Continued sessions are compacted when the model-facing transcript exceeds
48,000 characters. Override the deterministic character budget when needed:

```sh
./kodr run -p "Continue the work" --continue --session-context-chars 24000
```

Compaction preserves the frozen system prompt and recent user-led turns. Older
turns are replaced by an extractive summary built from the transcript and run
artifacts. Raw transcripts remain available in `conversation-raw.json`.

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

TUI color is automatic for interactive terminals. Use `NO_COLOR=1` to disable
ANSI color or `FORCE_COLOR=1` to force it.

Long-running agent and subagent stages emit grey progress lines in the TUI and
stderr info lines in non-JSON CLI runs, such as `planner started`,
`implementer finished`, and reviewer pass/fail summaries. These are shared
channel progress events, so future UIs can reuse the same feed.

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
- `conversation-raw.json`
- `session-summary.json`
- `raw-request.json`
- `raw-response.json`
- `context.md`
- `writes.json`
- `install.json`, when dependency install runs
- `docker.json`, when Docker sandbox metadata is recorded
- `openshell.json`, when OpenShell sandbox metadata is recorded
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
- `--docker-sandbox` runs install/test/tool commands in a fresh container.
- `--openshell-sandbox` runs command effects in a policy-controlled local
  OpenShell sandbox and refuses silent fallback.
- Local model requests default to a long timeout: `600000ms`.
