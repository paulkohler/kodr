# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 254)

`kodr check` is a complete standalone diagnostic. The staged execution pipeline
(`runStagedPrompt`) and `lang:node` builtin skill have been hardened through
phases 213–254: reasoning-runaway fast-fail and heal cap (231/234/236), staged
implement-turn runaway detect-and-retry (240), heal context-overflow retry (241),
terminal surfacing of staged-runaway and heal-overflow events (242), lang:node
StatementSync row-access pitfall (243), reasoning-runaway proximity guard (244),
staged plan text in heal repair context (245), SQLite test state reset pitfall (246),
system prompt hardening (247), task-gating SQLite/HTTP skill sections (248),
db-injection createApp(db) pitfall (249), --prompt-file context-signal threading (250),
SQLite gate keyword refinement (FTS5/:memory:) and staged planning max_tokens cap (251),
FTS5 trigger vs manual delete conflict pitfall (252),
FROM-base/WHERE-fts FTS5 MATCH failure form pitfall (253),
external-content FTS5 trigger pseudo-row delete syntax (254).

## Candidates

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

### lang:node node:sqlite import wrong-form expansion
Phase-253 dogfood: model cycled through three wrong import forms before max_turns:
`import { open } from 'node:sqlite'` (no such export), `import sqlite from
'node:sqlite'; new sqlite.Database(...)` (sqlite.Database not a constructor), and
`import { Database } from 'node:sqlite'` (already in the skill). Also used
`await db.exec()` / `await db.run()` throughout — node:sqlite has no async API.
Expand the existing Import Name pitfall to also show the `open` and default-export
wrong forms, and add a note that all node:sqlite methods are synchronous (no await).

### lang:node IncomingMessage has no .text() or .json() — use event streaming
Phase-252 dogfood: model wrote `const body = await req.text()` inside an
`http.createServer` handler. `IncomingMessage` is a Node.js stream with no
`.text()` or `.json()` methods (those exist on the Web Fetch `Request` API).
The correct pattern for reading a JSON body in node:http is to collect `data`
chunks and call `JSON.parse` on the concatenated string. Add a pitfall to the
lang:node HTTP section showing the wrong form and the correct stream-collector
pattern.

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
