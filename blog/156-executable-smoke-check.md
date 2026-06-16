# Phase 156: Running the Code, Not Just Reading It

The phase-155 capability stress test built a genuinely impressive thing: a qwen-authored
Express/JWT/pg API with correct cross-file wiring, parameterised SQL, and a Postgres
schema that initialised cleanly against a live `postgres:16` container. Kodr reported
`ok=true`. The app did not start. `src/auth.mjs` had

```js
import { sign, verify } from "jsonwebtoken";
```

and jsonwebtoken is a CommonJS package whose named exports are not statically
detectable, so Node throws at module-link time: *does not provide an export named
'sign'*. A one-line bug that makes the whole API dead on arrival — and every gate in the
default pipeline waved it through.

## Why every existing gate missed it

`node --check` (the phase-121 syntax gate) only *parses* each file. It never resolves
imports or links the module graph, so a missing export is invisible to it — that error
is a link-time error, not a parse error. With `--no-test` (or no detectable test
command) the only remaining gate is the advisory model-reviewer, which reasons about
source but never *loads* it. The telling contrast from the same stress test: on the
static-site half, the reviewer caught both real bugs by static reasoning. It is
specifically *load-time* errors that slip through, because catching them requires
actually evaluating the module graph — and for a CJS dependency, you cannot know what it
exports without running it.

## The probe

Phase 156 adds an executable smoke-check. After writes are applied and the syntax gate
passes, if the project has a detectable JS entry point (`scripts.start` of the form
`node <file>`, else `main`), Kodr `import()`s that entry in a child process:

```
node --input-type=module --eval '<loader that dynamic-imports KODR_SMOKE_ENTRY>'
```

The entry's absolute path is passed via an environment variable, never interpolated into
the eval'd source. A dynamic import resolves *after* top-level evaluation, so a server
entry that calls `app.listen()` resolves the instant `listen` returns synchronously — the
loader then exits 0 and the dangling socket dies with the process. An entry that throws
at import rejects, and the loader exits non-zero with the stack. On the Express project,
the probe exits non-zero with exactly the jsonwebtoken error.

## The hard part was *not* over-reporting failure

A load probe that executes code has two ways to lie, and both produce false negatives
that would train the user to ignore it:

- **Dependencies not installed.** The default pipeline does not `npm install`. A
  bare-specifier `ERR_MODULE_NOT_FOUND` means the deps aren't on disk, not that the code
  is broken. The probe classifies that as `skipped` (advisory), while the missing-*export*
  SyntaxError — a different error entirely — stays `failed`. That distinction is the whole
  reason the probe is trustworthy: it fails the jsonwebtoken case and stays quiet when
  `express` simply isn't installed yet.
- **Unsettled top-level await.** The first timeout test used `await new Promise(() => {})`
  as a "hangs forever" entry. It doesn't hang — Node detects an unsettled top-level await
  when the event loop empties and exits with code 13 almost immediately. But nothing was
  *thrown*, so this must not be a hard failure either; it's mapped to inconclusive. The
  timeout path (process-group kill) is reserved for a genuine hang — a keep-alive timer
  with a pending await.

So the strictness rule is: a clean thrown error fails the run (parallel to the syntax
gate — an app that throws at import provably cannot start); everything inconclusive
(deps missing, unsettled await, timeout) is surfaced as a warning but never fails.

## Trust boundary

This *executes* untrusted model-written top-level module code — a real escalation beyond
`node --check`'s parse-only. Three mitigations keep it honest: it runs **only on the
host and is skipped whenever a sandbox executor is active**, so it never escapes a
Docker/OpenShell sandbox to run model code on the host (on the host it is the same trust
level the test runner and dependency-install already cross); it is bounded by a timeout
and a process-group kill; and `--no-smoke` turns it off. Routing the probe *through* the
sandbox so it can run under Docker is recorded as follow-up.

## Result

On the phase-155 Express project, the run would now report `ok=false` with
`smoke check FAILED: src/auth.mjs — SyntaxError: … does not provide an export named
'sign'` in the Verification phase of `kodr why` — caught deterministically, not left to
a reviewer that never runs the code. Full suite 1,503 green (+22), and feeding a failed
smoke-check into the heal loop (so the model can attempt the fix automatically) is the
natural next step left for a follow-up phase.
