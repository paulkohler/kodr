# Phase 96: Project Config And Init

## Goal

Stop requiring a six-flag invocation for a useful run. Add a per-project
defaults file so conservative shipped defaults can coexist with a one-time
"make this project usable" setup.

The doc review that motivated this found the realistic daily invocation was
`--tools --yes --install --test "npm test" --heal --stream` — every option a
flag, every run retyped.

## Motivation

- Today the only places defaults can live are the shell and the model profile
  registry. `parseArgs(argv, env)` in `src/app.mjs` bakes env values into the
  initial options object (`MODEL_ID`, `BASE_URL`, `OPENAI_API_KEY` /
  `OPENROUTER_API_KEY`), and `.kodr/model-profiles.json` (phase 69) carries
  per-model parameters — context window, timeout, envelope. Neither can
  express "this project's test command is `npm test`" or "this project wants
  tools and streaming". Those facts are per-project, not per-model and not
  per-shell.
- Phase 97 (usable read defaults) explicitly depends on this phase: its new
  auto-defaults for `--tools`, `--stream`, and `--heal` must be overridable
  "from the phase 96 project config". Landing the config layer first means 97
  ships with its escape hatch built in.
- The precedence machinery already exists once. `applyModelProfileDefaults`
  in `src/model-profiles.mjs` resolves explicit-flag > profile > built-in
  using `_modelSet` / `_timeoutSet`-style sentinel fields that `parseArgs`
  sets and later deletes. Project config slots into that one resolution chain
  rather than growing a second, subtly different one.

## Design

### Config file

- `.kodr/config.json` holds per-project defaults. Discovery is cwd-relative,
  with a `KODR_CONFIG` env var to point elsewhere — mirroring how
  `resolveProfileConfigPath` handles `KODR_MODEL_PROFILES`.
- Initial key set, each mapping 1:1 to an existing `parseArgs` option and
  reusing that option's validation: `model` (full model specs allowed, e.g.
  `lmstudio/qwen/qwen3.6-35b-a3b`), `baseUrl`, `testCommand`, `testCwd`,
  `tools`, `stream`, `heal`, `timeoutMs`, `maxTurns`, `maxRetries`,
  `maxTokens`, `maxCostUsd`, `protectExisting`.
- The file is plain JSON read with `JSON.parse`, which has no comment syntax.
  Keys named `"//"` are reserved as comments and skipped silently; this is
  how `kodr init` writes an annotated starter file without inventing a new
  parser or format.

### Precedence

Most specific wins: explicit flags > environment > project config > model
profile > built-in defaults.

- Implementation extends the existing sentinel pattern. Today
  `model: env.MODEL_ID || DEFAULT_MODEL_ID` conflates "env provided" with
  "built-in default"; the resolution step must track the source so config can
  slot between them.
- Loading happens inside `parseArgs`-time resolution (alongside
  `applyModelProfileDefaults`), so every surface inherits it through the
  shared channel layer: CLI directly, TUI and `kodr serve` via the
  `state.options` they derive from the same parse. HTTP per-run JSON fields
  (`createTurnOptions` in `src/server.mjs`) count as explicit and override
  config, same as flags.

### Trust boundary

The config file is workspace content and therefore untrusted input — a
cloned repository can ship a tracked `.kodr/config.json` even though kodr's
own `.gitignore` excludes `.kodr*/`. It may set defaults but may not bypass
gates:

- Gate keys are rejected with an error naming the key — not silently
  ignored — so a config that tries to grant apply is conspicuous: `yes`,
  `gitCommit`, `installDependencies`, `enableHooks`, and `apiKey` (secrets
  stay in env) are never valid config keys.
- Config cannot approve skill commands or widen the verification allowlist:
  a config-supplied `testCommand` goes through the same
  `parseVerificationCommand` allowlist in `src/verification-runner.mjs` as
  the flag does, so it can only choose among already-allowlisted commands.
- HTTP runs stay dry-run by default regardless of config.
- Unknown keys (other than `"//"`) warn and are ignored; invalid values for
  known keys fail with the offending key named.

### `kodr init`

- New command branch in the `runCli` dispatch (`options.command === 'init'`).
- Detects the test command from `package.json` `scripts.test` and records it
  only in an allowlistable form (`npm test`); no script, no key.
- Records the currently resolved model and base URL (after profile
  resolution) so the starter reflects what a bare run would actually use.
- Writes the `"//"`-annotated starter config; refuses to overwrite an
  existing config without `--force`.

### Observability

- `kodr run --show-config` prints each resolved value with its source
  (`flag` / `env` / `config` / `profile` / `builtin`), following the
  print-and-exit precedent of `--show-files` / `--show-context` /
  `--show-skills`.
- The resolved config and per-key sources are recorded in `summary.json` so
  artifact replay shows where a setting came from.

## What Changes In Kodr

- New `src/project-config.mjs` owning load, validation, gate-key rejection,
  and merge order.
- `parseArgs` resolution gains the config step and source tracking;
  `runCli` gains the `init` branch; help text and `usage.md` document the
  file, the precedence order, and the new command.
- `summary.json` writers include the resolved-config provenance block.

## What Does Not Change

- With no config file present, every resolved option is byte-identical to
  today — the existing defaults are the regression lock.
- `.kodr/model-profiles.json` keeps its role (model-shaped parameters per
  provider/model); project config sits one precedence level above it, and
  neither file absorbs the other.
- Apply, install, hooks, sandbox, and skill-approval gates are untouched.

## Test Requirements

- Precedence matrix: for representative keys (`model`, `timeoutMs`,
  `testCommand`), each adjacent pair is tested — flag beats env, env beats
  config, config beats profile, profile beats built-in.
- Gate refusal: configs containing `yes`, `gitCommit`,
  `installDependencies`, `enableHooks`, or `apiKey` fail loudly naming the
  key; a config `testCommand` outside the verification allowlist is rejected
  at use exactly like the flag form.
- No-config regression: `parseArgs` output with no config file matches the
  pre-phase behavior.
- Init: `package.json` with a test script yields `testCommand: "npm test"`;
  absence yields no key; existing config refuses without `--force` and
  overwrites with it; the written starter parses with `JSON.parse` and
  round-trips through the loader (`"//"` keys skipped).
- Channel inheritance: TUI and `kodr serve` options reflect config defaults;
  an HTTP run body field overrides the config value for that run.
- `--show-config` output and the `summary.json` provenance block.

## Non-Goals

- No global user-level config file in this pass (env vars already cover it).
- No config-driven hooks or permission policy changes.
- No secrets in config — `apiKey` stays env-only.
- No JSON5/YAML/TOML; plain JSON with `"//"` comment keys only.
- No merging or deprecating `.kodr/model-profiles.json`.

## Done Criteria

- [x] Config file loaded, validated, and merged with the documented
      precedence, implemented in the existing sentinel-based resolution.
- [x] Apply/approval gate keys rejected loudly; verification allowlist
      unwidened by config.
- [x] `kodr init` scaffolds the annotated starter and detects the test
      command; refuses overwrite without `--force`.
- [x] `--show-config` prints resolved values with their source.
- [x] Resolved config and sources recorded in `summary.json`.
- [x] TUI and serve inherit config through the shared channel options.
- [x] Tests per Test Requirements (precedence, gates, init, no-config
      regression, channel inheritance, observability).
- [x] `usage.md` and help text updated.
- [x] Record decisions and any failures.
- [x] Blog post.
- [x] Mark roadmap complete and commit.
