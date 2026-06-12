# Phase 109 — Dogfood Harness Fixes

Phase 109 is the first phase whose spec was written entirely by running kodr
and watching it fail. Two dogfooding tests under `~/src/kodr-testing/phase-109`
— a brownfield bug fix on a copy of the `js-fix-failing-test` eval fixture, and
a greenfield word-frequency CLI — produced nine recorded failures and seven
fixes.

## The brownfield run that explained itself wrong

The headline failure: kodr in tools mode could not fix the simplest planted
bug (`add` returning `a + b + 1`). The run died with `turn_budget_exhausted`,
artifacts showed `responses: []` and `usage: null`, and the first diagnosis —
made by a frontier-model test operator reading those artifacts — was "the loop
budget initializes to zero and the run fails before any HTTP request."

That diagnosis was wrong, and the way it was wrong is the most instructive
part of the phase. Instrumenting the tool loop showed eight real model turns:

1. The model read both files and **correctly diagnosed the bug by turn 5**.
2. It tried to apply the fix via `run_command` — first `sed -i`, then
   `node --eval` with a `writeFile` — both correctly blocked by the
   verification allowlist.
3. With no write tool (writes are supposed to arrive in the final JSON
   proposal) and nothing steering it back to the envelope, it re-ran the
   failing test until the turn budget died.

The misdiagnosis was possible because of a second bug: on `LoopBudgetError`
the run hard-failed and threw away the entire conversation. The artifacts
honestly looked like no model call had happened. A harness that loses its own
evidence on the failure path will get its failures explained wrong — by
humans and by models.

## The fixes

**Tool-loop steering (F1).** Blocked non-allowlisted `run_command` calls now
carry a hint that file changes belong in the proposal's `files` array. Exact
repeat tool calls are short-circuited with a synthetic result telling the
model to stop calling tools and produce the proposal — in this loop nothing
can change between identical calls, so re-execution is pure waste. And when
exactly one turn remains, the request is sent without tools plus an instruction
to return the final proposal now, converting budget exhaustion into a final
answer.

**Salvage on exhaustion (F2).** If the budget still runs out,
`completeWithToolCalls` returns the accumulated responses, messages, and usage
with stop reason `turn_budget_exhausted` instead of throwing. Proposal
extraction and artifact writing proceed normally; the evidence survives.

**Forensics honesty (F3–F5).** `.kodr/last-run` is now written on failed runs
too, so bare `kodr why` works at exactly the moment it is most needed. The
Model Call story step reports `fail` with the error message when the run died
in the model loop, instead of a green check over zero responses. And
`kodr why .kodr/runs/<id>` — the form every user will naturally type — now
resolves against the cwd and errors clearly on a non-run directory, instead of
double-prefixing to `.kodr/runs/.kodr/runs/<id>` and rendering an all-skip
story.

**Repair context hygiene (F6, F7).** The greenfield test's repair context
contained a ghost `test/wordfreq.mjs` with empty content that never existed on
disk — paths inferred from test output are now existence-checked before
inclusion. And `workspaceFileCount` no longer reports 0 for every tools-mode
run; it counts the file map when the packed file list is empty.

## The test suite was harness too

Closing the phase required a green `npm test`, and the suite itself failed the
audit twice. First, `npm test` hung forever: every test in
`lsp-client.test.mjs` passed, but the file's process never exited. The cause
was a real product bug — `runLspInspector` spawns the language server and, when
`initialize` times out, rethrows without killing the child. The orphaned server
kept the event loop alive, and with `--test-timeout=0` the runner waited
indefinitely. In a real `lsp: auto` run the same path orphans a real language
server process. Second, the watcher test failed deterministically on this
machine because macOS FSEvents delivers an event for the freshly created watch
root itself, and the test asserted on the first debounced batch. One product
fix, one test fix — both confirmed pre-existing at HEAD before this phase's
diff. A hang that "only happened once" for a human happened on the first
automated run; suites that cannot fail loudly fail silently instead.

## What stayed open

Three findings were deliberately left in `NEXT.md` rather than fixed here:
repair-turn model calls reliably hitting the full 600s timeout (the repair
prompt is much larger than the main prompt), whether detected wrong-path
repairs should be gated rather than applied-with-a-warning, and whether
qwen3.6's profile should default native tool calls off. Each is a design
question, not a bug.

## Process notes

This phase also marks a workflow change recorded in `AGENTS.md`: future work
is brainstormed loosely in `NEXT.md`, and a phase file — the implementation
plan — is written as late as possible, only when the phase is actually next.
Phase 109's spec was written the day it was implemented, from evidence files
recorded the same day. That is the intended shape going forward.
