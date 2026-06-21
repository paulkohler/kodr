import {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL_ID,
	DEFAULT_REVIEW_TIMEOUT_MS,
	DEFAULT_TIMEOUT_MS,
	OPENROUTER_DEFAULT_MODEL,
} from './defaults.mjs';
import { OPENROUTER_BASE_URL } from '../completion.mjs';
import { DEFAULT_SESSION_CONTEXT_CHARS } from '../session-compaction.mjs';
import { VERSION } from '../version.mjs';

export function usage() {
	return `kodr ${VERSION}

Usage:
  kodr --help
  kodr --version
  kodr probe [--json]
  kodr init [--force]
  kodr run -p "task" [--json]
  kodr run --prompt-file prompt.md [--out .kodr/runs/name] [--prompt-id slug]
  kodr run -p "task" --dry-run
  kodr run -p "task"              # applies writes and runs detected tests
  kodr run -p "task" --confirm    # TTY: prompts apply? [y/N]
  kodr run -p "task" --yes [--install] [--test "npm test"] [--test-cwd path] [--heal]
  kodr run -p "task" --yes --commit
  kodr undo [--json]
  kodr run -p "task" --yes --docker-sandbox [--docker-keep] [--test "npm test"]
  kodr run -p "task" --yes --openshell-sandbox [--openshell-keep] [--test "npm test"]
  kodr run --prompt-file prompt.md --openshell-worker --yes [--install] [--test "npm test"]
  kodr run -p "task" [--no-tools] [--no-stream] [--wire-no-stream] [--no-heal] [--no-inspect-context]
  kodr run -p "task" --tools --hooks [--hooks-config .kodr/hooks.json]
  kodr run -p "task" --yes --no-protect-existing
  kodr run -p "task" --tools --yes --staged
  kodr run -p "task" --yes --subagent-stages
  kodr run -p "task" --stream
  kodr run -p "task" --tools
  kodr run -p "task" --inspect-context
  kodr run -p "follow up" --continue
  kodr run -p "follow up" --session <run-id>
  kodr tui [--session <run-id>]
  kodr tui --continue
  kodr serve [--host 127.0.0.1] [--port 8787] [--max-active-runs 1] [--web-dir path]
  kodr inspect [--symbol name] [--file path] [--languages js,py] [--json]
  kodr registry [--json]
  kodr run --show-files
  kodr run --show-context
  kodr run --show-skills
  kodr run --show-config
  kodr cycle-review --transcript-file chat.md [--json]
  kodr compare -p "task" --models "m1,openrouter:m2" [--json]
  kodr eval --suite evals/suite.json [--json] [--record] [--cases id1,id2]
  kodr bench --suite evals/suite.json [--base-url URL] [--json]
  kodr prompt-history <promptId> [--json]
  kodr session list [--json]
  kodr session show <sessionId> [--json]
  kodr session export <sessionId> --format markdown
  kodr replay <run-dir>
  kodr trends [--json | --html] [--runs-dir .kodr/runs] [--since <run-id>] [--last N]
  kodr route [--json] [--min-runs N] [--apply]
  kodr run -p "task" --route-auto
  kodr evals [--json] [--runs-dir evals/results]
  kodr watch --test "npm test"
  kodr check [dir] [--changed] [--deep] [--ci] [--no-smoke] [--no-sensors] [--strict] [--fix] [--watch] [--json]
  kodr hook install [--pre-push] [--force]
  kodr hook status [--json]
  kodr hook uninstall [--pre-push] [--force]

Project config:
  kodr init             Write a starter .kodr/config.json with the currently
                        resolved model, base URL, and (when package.json has a
                        test script) testCommand: "npm test".
  --force               Overwrite existing .kodr/config.json (init only).
  .kodr/config.json     Per-project defaults. Precedence (highest first):
                          CLI flags > env vars > project config > model profile > built-in defaults
                        Allowed keys: model, baseUrl, editFormat, testCommand, testCwd, tools,
                          stream, heal, inspectContext, lsp, timeoutMs, maxTurns, maxRetries,
                          maxTokens, maxCostUsd, protectExisting
                        Sensor block: { "sensors": { "secret-in-response": false } }
                          Disable individual sensors by name; all others remain enabled.
                        Hook block: { "hooks": { "preCommit": "cmd", "prePush": "cmd" } }
                          Override the baked-in hook command for install.
                        Gate keys rejected: yes, gitCommit, installDependencies,
                          enableHooks, apiKey
                        Keys named "//" are comment keys and are silently skipped.
                        Override the path with KODR_CONFIG env var.
  kodr run --show-config
                        Print each resolved config option with its source
                        (flag / env / config / profile / builtin) and exit.

Local-model defaults:
  --base-url URL       Default: ${DEFAULT_BASE_URL}
  --model ID           Default: MODEL_ID or ${DEFAULT_MODEL_ID}
                       Supports provider/model specs such as lmstudio/qwen/qwen3.6-35b-a3b
                       or openrouter/openai/gpt-4o-mini.
                       Model profile overrides: .kodr/model-profiles.json or KODR_MODEL_PROFILES.
  --agent-model A=S    Override subagent model for --subagent-stages.
                       Repeatable for planner, implementer, reviewer.
  --api-key KEY        Default: OPENAI_API_KEY
  --timeout-ms N       Default: ${DEFAULT_TIMEOUT_MS}
  --context-window N   Override active profile context window.
  --completion-reserve N
                       Override active profile completion reserve.
  --max-turns N        Max model turns in a run. Default: 8
  --max-retries N      Max continuation retries after length stops. Default: 7
  --max-thinking-tokens N
                       Optional provider/model thinking-token cap.
  --prompt-cache MODE  Prompt cache policy: auto or off. Default: auto.
                       Remote Anthropic model ids receive root cache_control.
  --max-tokens N       Optional total token budget from model usage
  --max-cost-usd N     Optional cost budget when the provider reports USD usage
  --session-context-chars N
                       Compact continued session context above this character budget.
                       Default: ${DEFAULT_SESSION_CONTEXT_CHARS}

OpenRouter:
  --openrouter         Use OpenRouter as the provider (base URL: ${OPENROUTER_BASE_URL})
                       Default model: ${OPENROUTER_DEFAULT_MODEL}
                       API key: OPENROUTER_API_KEY env var (falls back to OPENAI_API_KEY)
                       All --base-url, --model, and --api-key flags still override these defaults.

  --models m1,m2       Comma-separated model specs for compare. Prefix with
                       "openrouter:" to route a model via OpenRouter.
  --prompt-id slug     Override the prompt id recorded in summary.json.
                       Defaults to a content hash for -p prompts or the
                       filename slug for --prompt-file prompts.
  --suite path         Path to an eval suite JSON file for kodr eval.
  --record             Append results to evals/results/<suite>/<model>.jsonl.
  --cases id1,id2      Comma-separated case IDs to run (default: all).
  --prior-scratchpad   Path to a scratchpad file to inject into the user message.
                       Use "last" to read from the most recent run's scratchpad.
                       Truncated to 2000 characters. Skipped if empty.
  --skill NAME         Force a discovered or built-in skill into context. Repeatable.
                       Without it, skills auto-activate by relevance to the prompt.
  --skills-dir DIR     Add a directory to the skill search path. Repeatable.
                       Built-in skills and .kodr/skills are always searched.
  --agent NAME         Run under a discovered persona agent (its system prompt
                       and bundled skills). Defaults to the built-in Kodr persona.
  --agents-dir DIR     Add a directory to the agent search path. Repeatable.
  --edit-format <whole|patch|blocks>
                       How the model formats file edits. Default: patch.
                         patch  — JSON patches/files envelope (default)
                         whole  — full-file rewrites in the JSON envelope
                         blocks — SEARCH/REPLACE blocks outside JSON (no json_schema)
  --apply-mode <proposal|live>
                       When captured writes land on disk. Default: proposal.
                         proposal — capture during the run, apply at completion
                                    through the run's apply decision.
                         live     — apply write_file and edit_file to disk
                                    immediately during the tool loop, with a
                                    safe-write backup so "kodr undo" works.
                                    Trade-off: writes land before end-of-task
                                    review; undo is available. In envelope mode
                                    (--no-tools) this flag is accepted but inert.
                       Configurable via applyMode in .kodr/config.json.
                       Precedence: flag > config > default (proposal).
  (apply default)      kodr run applies its writes and runs detected tests by
                       default. --dry-run proposes only (no apply, no tests);
                       --confirm asks y/N before applying on a TTY; --json stays
                       explicit (dry unless --yes) for scripting.
  --dry-run            Propose changes only — never write to disk, never verify.
  --confirm            Prompt y/N before applying (the pre-151 interactive gate).
  --route-auto         At run start, load .kodr/runs history and use
                       recommendModel to select the model — only when the model
                       was not set explicitly by flag, env var, or project config.
                       Silent no-op if history is empty. Also configurable as
                       routeAuto: true in .kodr/config.json.
  --no-language-guidance
                       Force the Node/ESM contract block off even when the
                       workspace signals Node/ESM. The A-arm for measuring the
                       guidance's effect (phase 124); not for normal use.
  --no-model-guidance  Force the model-family guidance block off even when the
                       model matches a known family. The A-arm for measuring
                       model-guidance's effect (phase 145); not for normal use.
  --staged             Force plan-first staged execution for complex work.
  --no-staged          Disable automatic staged execution.
  --subagent-stages    Run planner, implementer, and reviewer as isolated tool agents.
  --no-review          Skip the advisory reviewer stage in --subagent-stages runs.
  --wire-no-stream     Disable SSE streaming on the wire. Required for thinking models
                       (e.g. qwen3.6) on LM Studio where max_thinking_tokens is only
                       honored in non-streaming mode. Also set via model profile.
  --first-token-timeout-ms N
                       Abort and retry if no first SSE chunk arrives within N ms.
                       Default: 120000 (120s). Also configurable per model profile.
  --idle-timeout-ms N  Abort (no retry) if a started stream goes silent for N ms
                       mid-response. Default: 120000 (120s). Catches mid-stream
                       stalls the first-token deadline cannot (phase 126).
  --repair-timeout-ms N  Per-turn repair model timeout. Default: min(--timeout-ms, 240000).
  --review-timeout-ms N  Reviewer model timeout. Default: min(--timeout-ms, ${DEFAULT_REVIEW_TIMEOUT_MS}).
  --test CMD           Verification command to run after applied writes.
                       Allowlisted (npm test, npm run test, node --test, …).
                       run/tui auto-detect one when unset; --no-test opts out.
  --test-cwd PATH      Directory to run the verification command in. Default: cwd.
  --no-test            Disable verification: skip auto-detection and clear any
                       inherited --test/config test command for this run.
  --patch-retries N    Patch-application repair attempts before giving up on a
                       failed patch. Default: 2. --no-patch-retries sets it to 0.
  --protect-existing   Refuse to overwrite existing files via files[] (use
                       patches/edit_file instead). On by default;
                       --no-protect-existing allows full-file overwrites.
  --install            Run controlled dependency install after applied writes.
                       Uses npm ci when package-lock.json exists, otherwise npm install.
  --heal               After failed verification, run a bounded repair loop.
                       Default: auto (on when --yes and --test are both set).
  --no-heal            Disable automatic healing even when --yes and --test are set.
  --no-smoke           Disable the executable smoke-check (load-probe the project
                       entry point after applying writes). On by default for
                       applied JS writes with a detectable entry; skipped under a
                       sandbox. A definitive load failure fails the run.
  --no-sensors         Disable deterministic cross-reference sensors (compose ↔
                       Dockerfile, CSS selector ↔ HTML). On by default; advisory
                       only (warn, not fail).
  --ci                 (kodr check) Shorthand for --changed --strict. Scans
                       only git-modified files and promotes warnings to
                       failures. Designed for CI pipeline and pre-commit use.
  --deep               (kodr check) Extend import-cycle detection to follow
                       imports transitively into existing workspace files
                       (not just the changed/written set). Only cycles
                       touching the write set are reported.
  --strict             (kodr check) Promote advisory warnings — smoke-check
                       failures and sensor warns — to check failures. Exit 1
                       when any warning fires. Useful as a pre-commit gate.
  --fix                (kodr check) When issues are found, synthesise a targeted
                       repair prompt and pass it to the local model. Applies
                       writes by default (like kodr run). Re-runs the check
                       after the fix to show whether the repair worked.
  --watch              (kodr check) Re-run the check on every file change.
                       Debounced 300ms. Ctrl-C to exit.
  kodr hook install [--pre-push] [--force]
                       Install a git pre-commit hook that runs
                       kodr check --changed --strict. --pre-push installs
                       a pre-push hook (kodr check --strict) instead.
                       Refuses to overwrite a foreign hook without --force.
  kodr hook status [--json]
                       Report whether kodr-managed hooks are installed
                       (kodr / foreign / none) for both pre-commit and
                       pre-push. --json emits a structured object.
  kodr hook uninstall [--pre-push] [--force]
                       Remove the kodr-installed hook. --pre-push targets
                       the pre-push hook. Requires --force for foreign hooks.
  --lsp                Enable LSP enrichment (run all available LSP servers on PATH).
  --no-lsp             Disable LSP enrichment.
                       Default: auto (use any LSP server found on PATH; skip silently
                       if none are available).
  --commit             After a clean apply (and passing tests when --test is set),
                       git-commit exactly the applied files with a run-referencing
                       message. Requires --yes. Git use is allowlisted; no push.
  --hooks              Enable configured command hooks. Default config: .kodr/hooks.json
                       Lifecycle: PreToolUse (prevent) -> PostToolUse (audit) -> Stop (loop guard).
                       Hooks run on the host, or in the active Docker/OpenShell sandbox.
  --hooks-config PATH  Hook config path relative to the workspace.

Docker sandbox:
  --docker-sandbox     Run install/test/tool commands inside Docker.
  --docker-image IMAGE Container image for sandbox commands. Default: node:24-bookworm-slim
  --docker-network NET Container network mode. Default: none, or bridge with --install
  --docker-workdir DIR Container workspace mount path. Default: /workspace
  --docker-keep        Keep sandbox containers after commands complete.

OpenShell sandbox:
  --openshell-sandbox  Run install/test/tool commands inside OpenShell.
  --openshell-worker   Run a nested Kodr worker inside OpenShell and download artifacts only.
  --openshell-from SRC Optional OpenShell sandbox source accepted by --from.
  --openshell-policy P Explicit policy YAML. Required with --install.
  --openshell-keep     Keep the sandbox after the run for inspection.

Undo:
  kodr undo            Revert the last applied run using its write manifest and
                       safe-write backups. Refuses when applied files were edited
                       after the apply. Works in git and non-git workspaces.

Watch mode:
  kodr watch --test CMD
                       Watch for file changes and run CMD on each change.
                       On failure, propose a repair as a pending review —
                       never auto-applies. --test accepts the same allowlisted
                       commands as --heal (npm test, node --test, etc.).
                       Ctrl+C or SIGTERM stops the loop.

Web channel:
  kodr serve           Start a local-only JSON HTTP control plane with a built-in web UI.
                       Open http://127.0.0.1:8787 in a browser to use the UI.
                       API: POST /runs, GET /runs(/:id), GET /runs/:id/events (SSE),
                       GET /runs/:id/logs, GET /runs/:id/artifacts(/:name), POST /runs/:id/cancel
                       Sessions: GET /sessions(/:id), POST /sessions/:id/turns
                       Inspection: GET /health, GET /status. Compatibility: POST /turn
                       Token streaming: SSE carries live token events (not replayed on reconnect).
  --max-active-runs N  Concurrent active HTTP runs (default 1; queued otherwise).
  --web-dir PATH       Serve static web assets from PATH instead of the built-in src/web/.
                       Useful for a custom UI; unknown extensions return 404.

Implemented library primitives:
  workflow planning, bounded cycles, one-shot healing, ReAct tools, model comparison
`;
}
