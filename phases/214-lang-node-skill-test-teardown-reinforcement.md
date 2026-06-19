# Phase 214 — lang:node Skill: Test Teardown and Port Reinforcement

## Goal

Phase-212 dogfooding gave two C grades despite the skill containing the right patterns:

1. **closeAllConnections** — model's scratchpad said "closeAllConnections then
   server.close" but implementation used `fork()+SIGTERM`, sidestepping the
   taught pattern entirely.
2. **Port coercion** — model ignored `process.env.PORT` and used `process.argv[2]`
   instead of `parseInt(process.env.PORT) || 3000`.

The skill has correct code examples for both, but the model bypasses them when it
adopts an alternative test architecture (subprocess). Fix: add explicit "do not"
directives and a standalone server-startup port pattern so there is no ambiguity.

## Changes

### `src/builtin-skills/languages/node/SKILL.md`

**HTTP integration test patterns section** — add two directives:

1. "No subprocesses in integration tests" note before the teardown example:
   > Always write integration tests inline with `before`/`after` hooks.
   > Do not use `child_process.fork()`, `spawn()`, or `exec()` to start the server
   > in a test — the teardown and port patterns below don't apply to subprocesses,
   > and assertion failures inside a forked process don't propagate back as test failures.

2. After the dynamic port capture example, add a server-startup port pattern
   (for the server's own startup code, not tests):
   ```js
   // Server startup — always parseInt; bare string coercion is wrong
   const port = parseInt(process.env.PORT) || 3000;
   server.listen(port, () => { console.log(`Listening on ${port}`); });
   ```

These additions make the "no subprocess" rule explicit and give the model the port
startup pattern in the same block as the test port pattern.

### `src/builtin-skills.json`

Rebuild by running `npm run build-skills`.

## Done criteria

- [x] "No subprocess" directive added before the teardown example.
- [x] Server-startup port pattern added after the dynamic port capture example.
- [x] `npm run build-skills` runs cleanly (builtin-skills.json updated).
- [x] `npm run format && npm run check` clean.
- [x] Budget tests in `test/system-env.test.mjs` still pass (measure actual size,
      update limit if needed — skill is larger now).
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
