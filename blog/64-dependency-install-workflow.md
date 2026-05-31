# Phase 64: Dependency Install Workflow

The Nemotron Postgres example reached the point where model quality and harness
control were colliding.

Kodr could generate `package.json`, Express routes, migrations, Docker Compose,
and tests. Phase 58 then made sure the run failed when no verification happened.
That was the correct failure, but it left the next practical gap: a generated
Node app often cannot be tested until dependencies are installed.

Phase 64 adds a controlled install step. `kodr run --install` runs after applied
writes and before verification. It is not a shell escape and it is not a model
tool for arbitrary package-manager commands. The allowlist accepts only
`npm install` and `npm ci`; Kodr chooses `npm ci` when `package-lock.json`
exists and otherwise uses `npm install`.

The result is written to `install.json` and `.kodr/last-install.md`. If install
fails, the run fails and verification is skipped. That keeps the failure
machine-visible while preserving the generated files for the next repair turn.

The take5 result should now be rerun with an explicit install and test command:

```sh
kodr run \
  --prompt-file prompt.md \
  --tools \
  --yes \
  --install \
  --test "npm test" \
  --out .kodr-nemotron-test2 \
  --model nvidia/nemotron-3-nano-omni \
  --max-turns 50 \
  --max-retries 3 \
  --timeout-ms 600000
```

That will not magically make a bad generated test pass. In fact, this example is
expected to expose the next repair target: the model wrote Jest-style test
globals instead of native `node:test` imports. The difference is that Kodr can
now reach that failure itself rather than needing a human-driven install step.
