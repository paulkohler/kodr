# Phase 150 — Defaults Favour Work

## Motivation

Follow-on to phase 149. Lazy-loading changed *when* code imports, not *whether* a
feature runs — but auditing the defaults for the lever surfaced one real
inconsistency and two product gaps that make `kodr tui` feel inert straight up:

1. **TUI started with tools OFF.** `createTuiState` seeded `tools: options.tools
   === true`, but `options.tools` defaults to the string `'auto'`, and `'auto'
   === true` is `false`. The one-shot `run` path treats `'auto'` as on (truthy),
   so `tui` was silently inconsistent — the model couldn't `read_file`/
   `list_files`/`run_command`/`write_file` until the user typed `/tools on`.
2. **TUI applied nothing by default.** `apply: options.yes === true` → dry-run
   unless `--yes`. For an *interactive* surface where you watch each change, the
   user wants writes to apply by default (with an easy off switch).
3. **No tests ran straight up.** Verification only runs when `--test <cmd>` or
   project config supplies a command. A fresh clone verifies nothing.

The goal: a bare `kodr tui` reads the system, writes files, and runs tests
out of the box, with explicit ways to turn each off. `tools` already had
`--no-tools`; LSP is already on by default (`lsp: 'auto'`) and loads the installed
language server when inspection runs (no flag needed) — both confirmed, no change.

## Changes

### 1. TUI tools on by default
`createTuiState`: `tools: options.tools !== false` (on for `'auto'`/`true`, off
only for `--no-tools` / a matched non-native model profile). Mirrors `run`.

### 2. TUI apply on by default
`createTuiState`: `apply: options.yes === true || !options._dryRunSet`. On by
default; `--dry-run` (or `/apply off` in-session) turns it off. One-shot `run`
is unchanged (still dry-run; the TTY interactive approver still applies there).

### 3. Auto-detect a test command
New `detectTestCommand(cwd)` (in `verification-runner.mjs`), file-presence based:
- `package.json` with a `scripts.test` → `pnpm test` (pnpm-lock.yaml) /
  `yarn test` (yarn.lock) / `npm test` (default).
- `package.json` without a test script, or no `package.json`, but Node test files
  present → `node --test`.
- `Cargo.toml` → `cargo test`. `go.mod` → `go test ./...`.
- `pytest.ini` / `conftest.py` / `pyproject.toml [tool.pytest…]` → `pytest`;
  otherwise `pyproject.toml`/`setup.py`/`setup.cfg`/`tox.ini` → `python3 -m
  unittest discover`.
- nothing recognised → `''`.

Wired in `app.mjs` `main()` for `run`/`tui`: when `options.testCommand` is empty
and not opted out, set it from detection and print an info line. An explicit
`--test`/project-config command takes precedence; `--no-test` disables detection.

Because verification is gated on the apply path, this mainly benefits `tui`
(apply-on) and `run --yes` — a plain dry-run `run` still won't execute tests.

### 4. Extend the verification allowlist (security boundary)
`parseVerificationCommand` adds `pnpm test`, `yarn test`, `pytest` (same no-shell
`spawn`, same trust boundary as `npm test`: they execute the workspace's own test
script/suite). The package.json parent-climb guard generalises to pnpm/yarn. The
`run_command` tool description is updated to list the real supported set. This
also widens what the model may run via `run_command` — intended.

### 5. Constitution
`AGENTS.md` dry-run rule reworded: one-shot `run` defaults to dry-run; interactive
`kodr tui` defaults to tools+apply on (the explicit apply behaviour the rule was
waiting for), disableable via `--dry-run`/`--no-tools`/in-session toggles.

## Testing

- `detectTestCommand`: unit tests over temp dirs (pnpm/npm/yarn/cargo/go/pytest/
  unittest/none).
- Allowlist: `pnpm test`/`yarn test`/`pytest` accepted; junk still rejected.
- `createTuiState`: tools on by default, off with `--no-tools`; apply on by
  default, off with `--dry-run`.
- Live integration: run at least one newly allowlisted command end-to-end where
  the tool is installed (per AGENTS.md security-boundary rule).
- `npm run format` + `npm run check` + full suite green.

## Done criteria

- [x] `kodr tui` defaults: tools on, apply on; `--no-tools` / `--dry-run` /
      `/tools off` / `/apply off` disable. (5 createTuiState tests.)
- [x] `detectTestCommand` returns sensible commands by file presence; wired into
      `run`/`tui`; `--no-test` opts out; explicit `--test`/config wins; source
      shown as `auto-detected` in `--show-config`. (10 detection tests + smoke.)
- [x] Allowlist extended (pnpm/yarn/pytest) with the same no-shell discipline;
      package.json parent-climb guard generalised; `run_command` description
      updated; **live integration**: `runVerification('pnpm test')` spawned real
      pnpm → `node --test` → `ok:true`. (pytest not installed → structural only.)
- [x] AGENTS.md dry-run rule updated to name the interactive-TUI default.
- [x] Tests added (+17, suite 1,464); `npm run check` + `format` + full suite
      green.
- [x] Blog `blog/150-defaults-favour-work.md`; `process/decisions.jsonl` entry.
- [x] Roadmap line checked; version bumped to 0.0.150.
