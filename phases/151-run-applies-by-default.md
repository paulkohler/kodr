# Phase 151 — `run` Applies and Verifies by Default

## Motivation

Continuation of phase 150 ("defaults favour work"). Phase 150 made `kodr tui`
apply-on and auto-detect a test command, but one-shot `kodr run` still defaulted
to dry-run, so `run` only executed the detected tests when it applied (interactive
accept or `--yes`). The user's call: **`run` should apply and verify by default**,
like `tui`, with `--dry-run` to opt out.

Tests can only be meaningful against code that exists on disk (`verificationCwd`
returns the real working tree; dry-run `prepareChanges` writes nothing). So
"`run` executes tests" necessarily means "`run` applies, then verifies." This
phase makes that the default.

## Change

In `app.mjs` `main()`'s `run` branch, when the user did not pass `--json`,
`--yes`, or `--dry-run`:
- `--confirm` + TTY → inject the interactive y/N apply approver (the phase-98
  behavior, now opt-in).
- otherwise → set `yes` on the run options so writes apply and the detected/
  configured test command runs (verification is gated on the apply path).

Opt-outs: `--dry-run` (propose only — no apply, no tests), `--confirm` (y/N prompt
on a TTY), `--no-test` (skip verification), `--json` (stays explicit: dry unless
`--yes`, for scripting). New `--confirm` flag added to `parseArgs`. Writes remain
git-aware and undoable (`kodr undo`).

The phase-98 interactive apply prompt is **not removed** — it becomes `--confirm`.
Its `main()`-level tests are preserved by adding `--confirm` to their shared
`BASE_ARGS`.

## Testing

- New: non-TTY `run` applies by default without prompting; TTY `run` without
  `--confirm` applies without prompting (a declining `n` on stdin is ignored).
- Updated: the former "dry-runs by default" / summary-rendering / envelope-message
  tests pin `--dry-run` (they test proposal/dry mechanics); the channel-contract
  shape-equivalence test pins `--dry-run` on both sides (CLI now applies, the raw
  channel run-turn does not — `--dry-run` keeps them shape-equivalent).
- `interactive-apply.test.mjs` prompt tests get `--confirm`; the late
  apply-proposal (TUI `/accept`) test pins `--dry-run` for its first turn.
- `npm run format` + `npm run check` + full suite green.

## Done criteria

- [x] `kodr run` applies its writes and runs detected/configured tests by default;
      `--dry-run` proposes only; `--confirm` restores the interactive prompt;
      `--json` stays explicit.
- [x] `--confirm` flag added and documented in `usage()`.
- [x] AGENTS.md rule updated (run + tui favour work; opt-outs listed).
- [x] Tests added/updated; full suite green (1,465).
- [x] Blog `blog/151-run-applies-by-default.md`; `process/decisions.jsonl` entry.
- [x] Roadmap line checked; version bumped to 0.0.151.
