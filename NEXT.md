# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 249)

`kodr check` is a complete standalone diagnostic. The staged execution pipeline
(`runStagedPrompt`) and `lang:node` builtin skill have been hardened through
phases 213–249: reasoning-runaway fast-fail and heal cap (231/234/236), staged
implement-turn runaway detect-and-retry (240), heal context-overflow retry (241),
terminal surfacing of staged-runaway and heal-overflow events (242), lang:node
StatementSync row-access pitfall (243), reasoning-runaway proximity guard (244),
staged plan text in heal repair context (245), SQLite test state reset pitfall (246),
system prompt hardening (247), task-gating SQLite/HTTP skill sections (248),
db-injection createApp(db) pitfall (249).

## Candidates

### SQLite skill gate: add FTS5 and :memory: as gate keywords
Phase-248 dogfood: the task used schema notation (`categories(id INTEGER PRIMARY KEY
...)`) with an FTS5 virtual table but never wrote `sqlite`, `DatabaseSync`, or
`CREATE TABLE`. Gate correctly didn't fire — but the model needed the SQLite
pitfalls. Add `FTS5` and `:memory:` to `/sqlite|DatabaseSync|CREATE TABLE/i` so
schema-focused tasks without the literal word "sqlite" still pull in the section.

### Staged planning request needs max_tokens for thinking models
Phase-248 dogfood: `--staged --prompt-file` timed out 3× on the planning stage.
The staged planning API call does not set `max_tokens`. For qwen3.6-35b-a3b,
LM Studio ignores `max_thinking_tokens` and only honors `max_tokens`. Without a
`max_tokens` bound, the model reasons indefinitely past 600s. Auto-staged (keyword
detection) works because it uses the full-system-prompt path. Fix: set `max_tokens`
on staged planning requests using the profile's `completionReserve` or a dedicated
planning cap.

### Staged pipeline: remind model to write package.json for third-party deps
Phase-246 staged dogfood: model wrote server.mjs importing express but never
wrote package.json. Without it, npm install never triggers and all tests fail
with ERR_MODULE_NOT_FOUND. The stage prompt says "write files" but doesn't
specifically prompt the model to write package.json when it uses packages not
in Node.js core. Consider adding a system-prompt reminder or a sensor that
detects a bare import with no matching package.json entry.

### Capped-retry zero-output on thinking models
Phase-245 dogfood: after a staged-runaway is detected and a capped retry is
issued (`max_thinking_tokens: 4096`, `max_tokens: 8192`), the model still burns
all 8,192 tokens on reasoning and emits 0 content chars (`finish=length`). The
proximity guard (phase 244) correctly skips the false-positive, but the retry is
wasted. Root cause: `max_thinking_tokens` may not be honored by LM Studio, or
the effective ceiling needs to be `max_thinking_tokens + output_budget` to
guarantee output tokens are available. Investigation: probe whether LM Studio
honors `max_thinking_tokens` on the retry call; if not, try setting `max_tokens`
to a much lower cap (e.g. `2048`) to force output before exhaustion.

### lang:node FTS5 trigger vs manual delete conflict
Phase-245 dogfood: model set up an `AFTER DELETE` trigger on the notes table
that automatically removed rows from the FTS5 table, AND also issued a manual
FTS5 delete in the `deleteNote()` function. The double-delete corrupted the FTS5
index (`ERR_SQLITE_ERROR: database disk image is malformed`). Add a pitfall to
the lang:node FTS5 section: if using triggers for FTS5 sync, do not also issue
manual FTS content table commands — pick one or the other.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met. Needs a human call and won't resurface on its own.

### llms.txt doc-lookup pattern for skills
BLOCKED on exposing a fetch tool to the model-callable registry (network-egress
security boundary: SSRF / private-IP / size guards, permission-gated, real
integration run required per AGENTS.md).

### Smoke-as-verification in the heal loop
Needs pluggable verification backends (callers pass a `verify` function instead
of `testCommand`). Significant architecture change — not plannable without an
interface sketch.
