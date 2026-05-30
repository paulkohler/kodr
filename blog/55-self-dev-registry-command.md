# Phase 55: Self-Dev — Registry Command

_Kodr editing Kodr. Second self-development trial._

Phase 54 was the first attempt to have the local model (`qwen/qwen3.6-35b-a3b`)
edit Kodr's own source code. It produced three harness failures and one useful
flag (`--protect-existing`). Phase 55 is the second trial — a harder task
(multi-file, new command wired through dispatch) — with those fixes in place.

The task: add a `kodr registry` subcommand that checks which external inspectors
from Phase 53's registry are available on the current machine.

---

## What changed from Phase 54

Three safeguards were in place going into this run:

**`--protect-existing`** blocks `files[]` overwrites of existing paths. The
model's worst failure mode (hallucinate a full file, apply over the real one) is
now caught before any write hits disk.

**Stronger system prompt** steers the model toward `patches` for existing files.

**Exact search strings in the prompt** — the biggest lesson from phase 54. The
model failed the test-patch because it guessed assertion names and indentation.
This time the prompt included the literal surrounding lines from the real file,
so the model had no need to guess.

---

## The run

Three obstacles before the model even got to write code:

**Obstacle 1 — test command not allowlisted.**
`node --test test/registry-command.test.mjs` wasn't in the verification runner's
allowlist. It only knew `node --test` (no file) and `node --check <file>`. The
fix: add `node --test <file>` as an allowlisted form. This exposed a secondary
failure — writes were already applied before the test command was validated.

**Obstacle 2 — writes applied before test command check.**
The `--yes` flow is: apply writes → run test. When the test command itself is
invalid, the writes are already on disk. The first run corrupted `src/app.mjs`
with partial state, requiring a `git checkout` to restore.

**Obstacle 3 — duplicate patches from a stale run.**
The first run left `test/registry-command.test.mjs` on disk as an untracked
file. `--protect-existing` then blocked the second run (treating the untracked
file as existing). Deleting the leftover and rerunning caused the model to
re-apply the same patches over already-patched content — doubling the import
and the command handler. A second `git checkout` and clean rerun resolved it.

**Final run: success on first clean attempt.**
With a clean working tree, the run applied 4 changes (3 patches to `app.mjs`,
1 new test file) and tests passed immediately. 297/297 test suite clean.

---

## What the model got right

The model produced all three patches with correct search strings on its first
attempt — because the prompt gave it the exact text to match. It did not invent
content or guess indentation.

The generated command handler:
- Imports `checkAvailability` and `REGISTRY` from the right module
- Maps over `REGISTRY` (reuses existing data, no duplication)
- Handles `--json` and human-readable text modes
- Returns `{ ok: true, command: 'registry', results }` matching the existing pattern

The generated test:
- Uses the same `capture()` helper pattern as other command tests
- Asserts result shape (array, `name`/`languages`/`available` fields)
- No mock — actually calls `checkAvailability` against the real environment

---

## What the harness still needs

**Validate test command before applying writes.** The current sequence (apply →
test) means a typo in `--test` leaves a dirty working tree. A pre-flight check
— parse and verify the test command is allowlisted before any write — would
prevent this class of corruption.

**`--protect-existing` should distinguish untracked from committed.** An
untracked file from a previous failed run should not block a new run that intends
to create that file. The check could use `git ls-files` to test whether a path
is tracked, only protecting committed files.

---

## Result

```
kodr registry

gopls                               go                      ✗
pyright                             python                  ✗
rust-analyzer                       rust                    ✓
typescript-language-server          javascript,typescript   ✗
```

`rust-analyzer` was present on the dev machine. The command correctly reported
all four registry entries with live availability checks, no hardcoded assumptions.
