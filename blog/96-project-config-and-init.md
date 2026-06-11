# Phase 96: Project Config And Init

The realistic daily invocation was:

```sh
kodr run -p "task" --tools --yes --install --test "npm test" --heal --stream
```

Every option typed from scratch on every run. Phase 96 puts those defaults in a
file.

## What Landed

**`.kodr/config.json`** holds per-project defaults. Every key maps 1-to-1 to an
existing `--flag`, with the same validation:

```json
{
  "//": "kodr project config",
  "model": "qwen/qwen3.6-35b-a3b",
  "baseUrl": "http://localhost:1234/v1",
  "testCommand": "npm test",
  "tools": true,
  "stream": true,
  "heal": true
}
```

Keys named `"//"` are comment keys, silently skipped by `JSON.parse`. This
keeps the parser to a single built-in call while letting `kodr init` write an
annotated starter.

**`kodr init`** writes the starter in one command. It reads the currently
resolved model and base URL (after profile resolution), and adds
`testCommand: "npm test"` when `package.json` has a `scripts.test` entry. It
refuses to overwrite an existing config without `--force`.

**Precedence** (highest wins):

> CLI flags > env vars > project config > model profile > built-in defaults

The implementation extends the existing sentinel pattern from
`applyModelProfileDefaults`. New `_toolsSet`, `_streamSet`, `_healSet`, and
similar sentinels track whether each option was explicitly provided via CLI
before config has a chance to supply it. Environment variables get their own
`_modelEnvSet` / `_baseUrlEnvSet` sentinels to distinguish "env provided this"
from "config or built-in default".

**`kodr run --show-config`** prints each option with its resolved value and
source:

```
model               qwen/qwen3.6-35b-a3b              builtin
baseUrl             http://localhost:1234/v1           builtin
tools               true                               config
stream              true                               config
heal                true                               config
testCommand         npm test                           config
timeoutMs           600000                             profile
...
```

## The `_timeoutSet` Trap

The first test run caught a precedence bug. `applyModelProfileDefaults` uses
`_timeoutSet` to decide whether to override `timeoutMs` with the profile value.
Config applied `timeoutMs: 12345` correctly, but then `applyModelProfileDefaults`
overwrote it because `_timeoutSet` was still `false` — the flag had never been
passed.

Fix: `applyProjectConfig` raises `_timeoutSet` to `true` after writing the
config value, so the profile step treats it as "already decided". The same
pattern applies to any future config key whose downstream resolution step
consults a sentinel.

## Security Boundary

Config is workspace content — a cloned repository can ship a tracked
`.kodr/config.json`. The gate keys (`yes`, `gitCommit`, `installDependencies`,
`enableHooks`, `apiKey`) are rejected with a named error, not silently ignored.
A config that tries to grant apply permission is conspicuous. `testCommand`
still goes through `parseVerificationCommand`'s allowlist at use time, keeping
the verification surface unchanged.

## What Did Not Change

No config file present → every resolved option is byte-identical to before the
phase. The test suite has a no-config regression test that pins this. `.kodr/model-profiles.json` keeps its role; the two files stack without merging.
