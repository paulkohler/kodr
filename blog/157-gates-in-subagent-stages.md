# Phase 157: A Feature That Only Half-Existed

Phase 156 shipped an executable smoke-check: load-probe a project's entry point so an
import-time crash (the kind that reported `ok=true` in the phase-155 Express stress test)
gets caught deterministically. The unit tests passed, and a real run against the broken
phase-155 project returned `status: "failed"` with the exact jsonwebtoken error. Done.

Except it wasn't. A comparison re-run of the stress tests — same tasks, driven by the
test-operator against the local model — came back with a blunt headline: the smoke-check
*did not fire*. `summary.smokeCheck` wasn't `failed`; it was **absent**. It never ran.

## Trust, but verify the operator

The standing lesson with the test-operator is that its mechanism-level root-cause claims
are often wrong, so you re-derive from the artifacts before believing them. This time the
claim was: "the smoke-check call lives only in the default pipeline path; the
`--subagent-stages` branch builds its own summary and never reaches it." I read the code
rather than trusting it — and it was exactly right.

`runPrompt` has two paths. When `--subagent-stages` is set it branches early into
`runSubagentStages`, assembles its **own** summary and `runOk`, and returns. Both
deterministic gates — the phase-156 smoke-check *and* the phase-121 `node --check` syntax
gate — live in the default path *below* that branch. Orchestration's own verification
(`runOrchestrationVerification`) runs the test command and nothing else, only when
`--test` is set. So in `--subagent-stages` mode — the mode used for every multi-file build
and every stress test — the only gate was the advisory reviewer. The syntax gate has been
missing from orchestrated runs since orchestration shipped; phase 156 just added a second
feature to the same blind spot.

The phase-155 crash this was all meant to catch? This round it couldn't be observed at
all: the probe never ran, *and* qwen happened to write the JWT import correctly this time
(`import jwt from "jsonwebtoken"`), so the app actually booted and served every endpoint
against a live Postgres. Non-determinism gave us a working app and hid the gap behind it.
But the gap is structural and independent of what qwen emitted — the feature was dead in
the mode that matters.

## The fix, and the rule it enforces

The constitution already says it: *route new user-facing surfaces through shared handling
instead of duplicating execution paths.* Phase 156 violated it by wiring only the default
path. Phase 157 wires both gates into the subagent branch, mirroring the default path —
syntax gate before the heal loop (and feeding it on failure, for parity), smoke-check
after the heal merge on the final tree, host-only and skipped under a sandbox. Both fold
into `runOk` and get recorded in the summary.

To stop the two paths drifting again, the ok-folding decision is now a single shared,
unit-tested helper:

```js
export function deterministicGateOutcome({ syntaxResult, smokeResult, testResult }) {
    const testPassed = Boolean(testResult && testResult.ok);
    return {
        syntaxFailed: Boolean(syntaxResult) && syntaxResult.ok === false && !testPassed,
        smokeFailed: Boolean(smokeResult) && smokeResult.status === 'failed' && !testPassed,
    };
}
```

Both branches call it. A future gate change happens in one place.

## Proof on a real orchestrated run

Per the boundary-feature rule (this executes model code), the proof is a live run, not a
fixture. A `--subagent-stages` qwen build (planner → two isolated file-authors → reviewer)
of a tiny ESM project now produces:

```
syntaxCheck: { checked: 1, ok: true }
smokeCheck:  { entry: "index.mjs", source: "start", status: "ok", durationMs: 178 }
```

Both were absent in subagent mode before this phase. The smoke-check found the entry from
the `start` script, imported it (ran its top-level `console.log` and exited clean), and
recorded the result — exactly the path that was empty.

## What the comparison also taught us (fallout → features)

The smoke-check is load-time only; it is blind to correctness, and in orchestration mode
the advisory reviewer was the *sole* correctness gate — and it false-passed two real
defects this round: the login route signed the whole user row (bcrypt `password_hash` and
all) into the JWT, and the website's CSS styled `#add-btn` / `.container` selectors that
exist nowhere in the markup, leaving required styling silently inert. Both are the same
shape: a cheap *cross-reference* a deterministic sensor could check without a model
(selector ↔ element, `build:` context ↔ Dockerfile, secret-named column ↔ token payload).
That's recorded in `NEXT.md` as the next place the reviewer's blind spots can become
deterministic checks. Full suite 1,508 green.
