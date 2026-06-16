# Phase 151: `run` Applies and Verifies by Default

Phase 150 made `kodr tui` agentic by default and taught Kodr to auto-detect a test
command. But one-shot `kodr run` still defaulted to dry-run, so it only executed
the detected tests when it actually applied — i.e. after the interactive accept
prompt or with `--yes`. Paul's call: `run` should apply and verify by default too.

## Why "execute tests" implies "apply"

A natural first instinct is "run the tests but don't apply." It doesn't work:
`verificationCwd` returns the real working tree, and a dry-run's `prepareChanges`
writes nothing to disk. So the only code a test command can see is the unmodified
tree — testing the proposal would test stale code. Running tests against the
proposed change without applying needs an isolated copy (a sandbox or a workspace
copy), which is a much bigger, slower feature. Given the choice, Paul picked the
simple, sound option: **apply, then verify.** `--dry-run` keeps the propose-only
path.

## The change is small; the blast radius isn't

The code change is a few lines in `main()`'s `run` branch: unless `--json`,
`--yes`, or `--dry-run` was passed, set `yes` so writes apply and the test command
runs. The phase-98 interactive prompt isn't deleted — it moves behind a new
`--confirm` flag.

The interesting part was the test fallout, which is exactly what you'd want a good
suite to do when you flip a default: it lit up everywhere the old default was
baked in.

- `interactive-apply.test.mjs` had a shared `BASE_ARGS` for its TTY prompt tests.
  Adding `--confirm` there restored the prompt for all of them in one line.
- A `channel-contract` test asserts a CLI run and a raw channel `run-turn` produce
  the same artifact *shape*. They diverged because the CLI path now applies and
  the raw channel call doesn't — and with a no-proposal chat answer, `yes=true`
  trips the "model returned no proposal" branch, which changes the summary's key
  set. Pinning both sides to `--dry-run` keeps them comparing the same thing.
- Three `app.test` cases named around "by default" / "proposed writes" / the
  dry-run summary text were really testing *proposal mechanics* (diffs, envelope
  messages, the "Re-run with --yes" hint). They get `--dry-run` to keep testing
  exactly that.

That's the tell that a default flip is honest work, not a config tweak: the
behavior oracle objects in precisely the places the behavior changed, and each
objection is resolved by stating the apply mode explicitly.

## The shape of "favour work" now

- `kodr run "fix X"` → proposes, applies, runs detected tests, shows the summary.
- `kodr run "fix X" --dry-run` → proposes only (no writes, no tests).
- `kodr run "fix X" --confirm` → y/N before applying on a TTY (the old default).
- `kodr run "fix X" --json` → unchanged: dry unless `--yes` (scripting stays
  explicit).
- `--no-test` skips verification; writes are git-aware and `kodr undo`-able.

Full suite 1,465 green; `check` + `format` clean.
