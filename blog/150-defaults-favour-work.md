# Phase 150: Defaults That Favour Work

Phase 149 made Tier-4 capabilities lazy-load. That prompted a fair question: did
deferring *when* code imports accidentally make features *opt-in by request*?
Answer: no — lazy-loading changes import timing, not whether a feature runs. A
thing gated behind `--lsp` is still behind `--lsp`; the `import()` just moved.

But auditing the defaults for that question surfaced a real inconsistency and two
gaps that made `kodr tui` feel inert out of the box.

## The bug: `'auto'` is not `true`

`tui.mjs` seeded its session state with:

```js
tools: options.tools === true,
```

`options.tools` defaults to the **string** `'auto'`, and `'auto' === true` is
`false`. So a bare `kodr tui` started with tools **off** — the model couldn't
`read_file`, `list_files`, `run_command`, or `write_file` until you typed
`/tools on`. Meanwhile the one-shot `run` path treats `'auto'` as on (it uses
`if (options.tools)`, which is truthy for `'auto'`). The two surfaces silently
disagreed. The `'auto'` value is meaningful — `applyModelProfileDefaults` resolves
it to the model profile's `nativeToolCalls` boolean when a profile matches — but
an unmatched model keeps `'auto'`, and only `tui` mistook that for "off."

Fix: `tools: options.tools !== false` — on for `'auto'`/`true`, off only for
`--no-tools` (or a matched non-native profile). It now mirrors `run`.

## The defaults the user actually wanted

For an *interactive* surface where you watch each change, applying is the point.
So `tui` now defaults apply-on too: `apply: options.yes === true ||
!options._dryRunSet`. On by default; `--dry-run` (or `/apply off`) turns it off.
One-shot `run` is unchanged — it keeps dry-run, per the constitution. The
`AGENTS.md` dry-run rule was reworded to name this interactive-TUI exception
rather than contradict it.

LSP, it turns out, needed nothing: `lsp` already defaults to `'auto'`, which the
inspector treats as "all servers allowed." It discovers whatever language server
is installed and noops if none is — exactly "loads when required."

## Tests that run straight up

Verification only ran when `--test <cmd>` or project config supplied a command, so
a fresh clone verified nothing. New `detectTestCommand(cwd)` picks a sensible
allowlisted command by file presence:

- `package.json` + a `test` script → `pnpm test` / `yarn test` / `npm test`
  (by lockfile); no test script but Node test files → `node --test`.
- `Cargo.toml` → `cargo test`; `go.mod` → `go test ./...`.
- pytest markers (`pytest.ini` / `conftest.py` / `[tool.pytest…]`) → `pytest`;
  otherwise `pyproject.toml`/`setup.py`/`setup.cfg`/`tox.ini` → `python3 -m
  unittest discover`.

`main()` wires it for `run`/`tui` when no command is configured (an explicit
`--test`/config wins; `--no-test` opts out), prints an info line, and labels the
source `auto-detected` in `--show-config`. Because verification is gated on the
apply path, this mainly benefits `tui` (apply-on) and `run --yes` — a plain
dry-run `run` still won't execute tests, which is the safe default.

## The security boundary

`pnpm test`, `yarn test`, and `pytest` weren't in the verification allowlist
(`npm test`, `node --test`, `cargo test`, `go test ./...`, `python3 -m unittest`
were). The allowlist is shared with the model-facing `run_command` tool, so
adding them widens what the model can execute — intended, and held to the same
discipline as `npm test`: parsed into a fixed `{bin, args}`, spawned with
`shell: false`, no argument interpolation. The package.json parent-climb guard
(refuse to let the package manager climb to a parent package) generalised from
npm to pnpm/yarn. Per the `AGENTS.md` security-boundary rule, the addition was
checked against the tools' real semantics **and** validated with a live run:
`runVerification('pnpm test')` against a temp project spawned the real pnpm,
which ran `node --test`, returning `ok:true, exitCode:0`. (pytest wasn't
installed on this machine, so it was verified structurally, not live.)

## Net effect

A bare `kodr tui` now reads the system (inspection on), writes files (tools on +
apply on), and runs tests (auto-detected) — with `--no-tools`, `--dry-run`, and
`--no-test` to dial any of it back. Full suite 1,464 green (+17).
