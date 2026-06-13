# Phase 120 — Live Apply Mode (opt-in)

## Motivation

The devstral circle-back (post-arc) surfaced the deepest tension the
two-channel model created: a native model encouraged to verify its own work
calls `write_file` (captured into the ProposalDraft, NOT on disk), then runs
`run_command: node --test` and gets `ENOENT: no such file`. devstral saw its
own files "missing", burned all 8 turns confused, and declared success without
real verification. The grounded write→run→observe→fix loop the arc celebrated
requires the model to see its own writes, but Kodr's proposal-safety model
defers them until task completion.

Two fixes were on the table. The full one — materialize the draft into a
scratch worktree — is deferred by decision (2026-06-13): interesting for big
repos later, but not now. This phase ships the **explicit, user-chosen
option**: an apply mode that writes immediately, opted into per run, leaving
the dry-run proposal model as the untouched default. Plus a small default-mode
mitigation so the common path stops thrashing.

Decision (2026-06-13): apply policy is a **workflow axis the user chooses**,
NOT a per-model property. A model being tool-`native` says it can use tools;
it says nothing about whether the user wants its writes hitting disk
unreviewed. The two are orthogonal; binding them would erode the dry-run
constitution for the wrong reason. Hence a flag/config, defaulting safe.

Evidence: `~/src/kodr-testing/phase-119-devstral/` (OPERATOR-REPORT.md, the
`write_file` → ENOENT sequence); `process/failures.jsonl` phase 119-devstral;
`src/tool-calls.mjs:48` (ProposalDraft), `:751`/`:792` (capture handlers),
`:568` (read_file), `:719` (run_command).

## Design principles

1. **Default is unchanged.** `apply-mode proposal` (the default) is
   byte-for-byte the phase-119 behaviour: capture into draft, apply at task
   completion behind the review/`--yes` gate. Every existing test stays green.
2. **Live is explicit and per-run.** A flag/config the user sets; never
   auto-selected by model identity or probe result.
3. **Live still respects the jail and keeps undo.** Live writes go through the
   same path-jail and safe-write backup machinery (phase 94) so `kodr undo`
   works; live is "apply now", not "bypass safety primitives".
4. **One source of truth per mode.** In live mode disk is the truth (writes
   landed). In proposal mode the draft is the truth (nothing on disk yet).

## Work items

### L1 — The option

- `--apply-mode <proposal|live>` CLI flag (default `proposal`), surfaced in
  `--help`. Reject any other value with a clear CliError.
- Config key `applyMode` in `.kodr/config.json` (same validation style as
  other keys in project-config.mjs; reject non-`proposal|live` values by
  name). Flag overrides config; config overrides the built-in default.
- Thread the resolved `applyMode` into the tool registry / capture handlers
  and the run loop. Record it in summary.json (`applyMode`).
- Envelope mode (no capture tools) + `apply-mode live` is meaningless —
  document that live mode applies to the capture tools; in envelope mode the
  flag is accepted but inert (writes still come from the end-of-run envelope
  apply). Do not error.

### L2 — Live write_file / edit_file

In `applyMode === 'live'`, the `write_file` and `edit_file` handlers apply to
the workspace immediately instead of only recording:

- `write_file`: jail the path (unchanged), write the complete content to disk
  through the existing safe-write primitive that records a backup (reuse the
  phase-94 apply path / `prepareWrites` so `kodr undo` restores prior state).
  Still record the entry in the ProposalDraft (so the run summary/diff/forensics
  report it) but mark it applied. Tool result: `wrote <path> (<bytes> bytes)`
  instead of "recorded … applies when the task completes".
- `edit_file`: apply the search/replace to the on-disk file immediately via the
  existing patch primitive (`preparePatches`), with backup; record + mark
  applied; result `edited <path>`. A patch whose search text is not found
  returns the existing patch-failure steering (now actionable, since the file
  is real).
- End-of-run apply must NOT double-write entries already applied live. The
  proposal is still assembled from the draft for summary/diff purposes, but the
  disk-write step skips already-applied entries. `summary.applied` is true; the
  interactive apply prompt / `--yes` gate is skipped in live mode (the user
  opted in — there is nothing left to apply).
- Verification-derived status (the 117 rule) is unchanged: live writes do not
  let the model declare success; `node --test` at end still decides ok.

### L3 — Proposal-mode read-back (default-mode mitigation)

Small fix so the DEFAULT path stops thrashing without changing safety: in
`applyMode === 'proposal'`, `read_file` checks the ProposalDraft first — if the
path was captured by `write_file`, return that captured content (prefixed with
a one-line note that it is a pending write not yet on disk). Otherwise read
disk as today. This lets a model re-read its own pending writes (the read leg
of the loop) without applying anything.

Scope honesty: this covers `read_file` of `write_file` captures only.
`edit_file` captures (search/replace, no full content) and `run_command`
(discovers files on disk) cannot be satisfied from the draft — for those, live
mode is the answer. Document this plainly; do not fake it. `run_command` in
proposal mode keeps its current behaviour (sees only applied files).

### L4 — Forensics and docs

- `summary.json` records `applyMode`; `kodr why` notes it ("apply mode: live —
  writes applied during the run" vs "proposal — applied at completion").
- `--help` documents `--apply-mode`; README/usage gets a short note (the user
  will fold this into their own notes). State the trade-off explicitly: live
  mode restores mid-session verification but writes land before the run's
  end-of-task review — undo is available, but the dry-run gate is off.

## Testing

- L1: flag parses to `applyMode`; invalid value → CliError; config key parses
  and validates; flag overrides config; default is `proposal`; summary records
  it.
- L2 (tmp workspace, fake server with write_file/edit_file tool calls):
  live `write_file` lands the file on disk DURING the loop (assert the file
  exists before end-of-run apply runs); tool result says "wrote"; end-of-run
  does not double-write (content correct, no duplicate backup churn);
  `kodr undo` restores prior state after a live run; live `edit_file` mutates
  the on-disk file; patch-not-found steers.
- L3: proposal-mode `read_file` of a captured path returns the captured content
  with the pending note; non-captured path reads disk; live mode reads disk
  normally.
- Regression: default proposal-mode run is byte-identical to phase 119
  (capture, end-of-run apply, review gate) — existing capture/apply/envelope
  tests stay green untouched.
- L4: summary.applyMode present; `kodr why` strings for both modes.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] L1: `--apply-mode` flag + `applyMode` config (default proposal),
      threaded + recorded in summary; invalid value rejected.
- [x] L2: live write_file/edit_file apply immediately via the jailed,
      backup-recording safe-write path; draft marked applied; no double-write
      at end; undo works; review gate skipped in live mode.
- [x] L3: proposal-mode read_file reads back captured write_file content with a
      pending note; scope limits documented.
- [x] L4: applyMode in summary + `kodr why`; `--help`/README note with the
      explicit trade-off.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/120-live-apply-mode.md`.
- [x] NEXT.md: trim the "Mid-Session Write Visibility" entry to just the
      deferred materialize/worktree half (option b); the option-(a)/live half
      ships here.
- [ ] Version bumped to 0.0.120; suite green; committed.
- [ ] Live validation (after the commit, sequential, devstral now at 131072):
      devstral greenfield with `--apply-mode live` — does `run_command`
      (`node --test`) now see its own `write_file` output and verify
      mid-session, instead of the ENODLE thrash from the circle-back? Record
      whether it reaches a real test result during the loop. Then a default
      (`proposal`) run to confirm no regression and that read_file read-back
      (L3) reduces confusion. Capture devstral's behaviour delta vs the
      circle-back run.
