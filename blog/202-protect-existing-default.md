# Phase 202: protectExisting On By Default

The three example runs from the session surfaced a consistent pattern: Session 2
rewrites Session 1 files from scratch. The model produces `files[]` entries with
full new content rather than `patches[]` entries that extend the existing code.
The result is silent API breakage — function signatures change, imports vanish,
async route handlers become Promise callbacks. Tests then fail in ways that look
like logic bugs but are actually contract violations.

`protectExisting` already existed as an opt-in (`--protect-existing`). It blocked
`files[]` overwrites of git-tracked files. Two problems made it useless in practice:

**Off by default.** Nobody passes `--protect-existing` because nobody expects to
need it. The flag exists for a safety property that should be on by default.

**Git-only.** The check ran `git ls-files --error-unmatch` to see if the file was
tracked. The example workspaces under `~/src/kodr-testing/` are not git repos, so
the check returned false for everything and the protection never fired.

## The fix

Replace the `isGitTracked` call with a `readExisting` check — the same function
already called in `prepareWrites`. If the file exists on disk, a `files[]` write
to it is rejected with:

```
SafeWriteError: Refusing to overwrite existing file via files[]: src/server.mjs — use patches[] instead
```

Change the default to `true`. Add `--no-protect-existing` as the opt-out for
callers that genuinely need full-file replacement (e.g. a scaffolding step that
owns a file it's re-generating).

Remove `isGitTracked` and the `execFile` import — both now unused.

## What changes in practice

A Session 2 run that tries to fully overwrite `src/server.mjs` now fails at apply
time with a clear error before any tests run. The heal loop sees a `SafeWriteError`
and can prompt the model to switch from `files[]` to `patches[]` for that target.

A first-session run is unaffected: the files don't exist yet, so `readExisting`
returns `{ exists: false }` and the write proceeds normally.

## Learnings

The guard is only as good as the heal loop's response to `SafeWriteError`. The
error message names the file and names the fix (`use patches[] instead`). Whether
the model picks that up and converts its output correctly is a question for the
next example run.
