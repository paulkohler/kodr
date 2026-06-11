# Phase 98: Interactive Apply Prompt

The CLI dry-run dead-end is gone. Before this phase, a one-shot run that proposed
writes would end with "Re-run with `--yes` to apply these changes" — meaning a
second multi-minute local inference for the same task, producing a proposal the
user could not compare to the one they just reviewed. Phase 98 adds an `apply?
[y/N]` prompt at the apply gate inside `runPrompt`, so the proposal is applied
exactly once, on the same model output the user already reviewed.

## The Gate

The decision point lives inside `runPrompt`, at the existing `prepareChanges`
call. The sequence when an approver is injected and writes are proposed:

1. `prepareChanges` runs in dry-run mode to get the real write list (status,
   path, hash per entry).
2. `createPermissionRequest('apply-writes', { writes, messages }, reason)` builds
   a request in the phase 67 shape.
3. The approver is called with that request.
4. On `decision: 'allow'`, `prepareChanges` runs again with `apply: true`.
5. `applyDecision` is set to `'prompt-accepted'`, `shouldApply` to `true`, and
   all downstream gates (install, test, heal) receive `shouldApply` instead of
   the raw `options.yes` flag.

The resolved `shouldApply` flows into `installDependencies`, `testCommand`, and
`runHealingIfNeeded({ ...options, yes: shouldApply })`, so an accepted prompt
runs the full `--yes` pipeline without a new execution path.

## Surface Wiring

Only the CLI `run` branch injects the approver, and only when:
- `io.stdin.isTTY && io.stdout.isTTY`
- `!options.json`
- `!options.yes`
- `!options._dryRunSet`

`_dryRunSet` is a new sentinel (following the `_*Set` pattern) that distinguishes
an explicit `--dry-run` flag from the default `dryRun: true`. Without it there
would be no way to know whether the user said "skip the prompt" or just "hasn't
said `--yes` yet."

The approver renders the file list and proposal messages, then writes `apply?
[y/N] ` and reads a line. Only `y` or `yes` (case-insensitive) accepts; empty
input, any other string, and EOF all decline.

TUI, `kodr serve`, openshell-worker, `--json`, non-TTY, `--yes`, and explicit
`--dry-run` all bypass the prompt — the approver is never injected for those
paths.

## apply-proposal Artifact Update

The `apply-proposal` channel handler (TUI `/accept` path) was applying writes but
never updating the originating run's `writes.json`. `undoLastApply` discovers
applied runs by reading exactly that file, so a TUI `/accept` was invisible to
`/undo`. The handler now writes `writes.json` (with `applied: true`) and updates
`summary.json` (`applied: true`, `applyDecision: 'late-apply'`) after a
successful apply. Both prompt-accepted CLI runs and TUI-accepted runs are now
findable by `/undo`.

## `summary.applyDecision`

Every run now records how the apply decision was made:

| Value | Meaning |
|-------|---------|
| `'flag'` | `--yes` was passed |
| `'prompt-accepted'` | Interactive prompt answered y/yes |
| `'prompt-declined'` | Interactive prompt declined or EOF |
| `'none'` | No approver available (non-TTY, `--json`, explicit `--dry-run`, serve) |
| `'late-apply'` | TUI `/accept` applied after `runPrompt` returned |

## Failures

**`rl.question()` hangs on immediate EOF**: When the test creates a Readable and
immediately pushes `null` (simulating EOF), `readline.question()` never resolves
because the stream's `end` event fired before readline attached. The fix is to use
`for await (const line of rl)` — readline's async iterator handles EOF by ending
the loop cleanly with `answer = ''`, which is the decline path.

**`io.stdout.isTTY` triggers `stream: auto → true`**: Setting `isTTY: true` on
the stdout mock triggers the existing stream auto-resolution in `main()`, which
sets `options.stream = true`. The fake model server does not speak SSE, so the
completion call returned no proposal. Fixed by adding `--no-stream` to all TTY
test invocations. The TTY flags remain present to trigger the approver injection
check; streaming is a separate concern.
