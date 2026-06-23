# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 260)

`kodr check` is a complete standalone diagnostic. The staged execution pipeline
(`runStagedPrompt`) and `lang:node`/`lang:sqlite` builtin skills have been hardened through
phases 213–260: reasoning-runaway fast-fail and heal cap (231/234/236), staged
implement-turn runaway detect-and-retry (240), heal context-overflow retry (241),
terminal surfacing of staged-runaway and heal-overflow events (242), lang:node
StatementSync row-access pitfall (243), reasoning-runaway proximity guard (244),
staged plan text in heal repair context (245), SQLite test state reset pitfall (246),
system prompt hardening (247), task-gating SQLite/HTTP skill sections (248),
db-injection createApp(db) pitfall (249), --prompt-file context-signal threading (250),
SQLite gate keyword refinement (FTS5/:memory:) and staged planning max_tokens cap (251),
FTS5 trigger vs manual delete conflict pitfall (252),
FROM-base/WHERE-fts FTS5 MATCH failure form pitfall (253),
external-content FTS5 trigger pseudo-row delete syntax (254),
node:sqlite import wrong-form expansion and synchronous pitfall (255),
node:test hook async pitfall — no done callback (256),
lang:sqlite extracted as standalone builtin skill (257),
multi-skill auto-injection: SQLITE_TASK_PATTERN gates lang:sqlite alongside primary language (258),
lang:sqlite FTS5 virtual-table column projection pitfall (259),
heal-turn reasoning-runaway suppressed retry: chat_template_kwargs + /no_think prefix,
new stop reason reasoning_runaway_after_retry (260).

## Candidates

### Staged pipeline: remind model to write package.json for third-party deps
Phase-246 staged dogfood: model wrote server.mjs importing express but never
wrote package.json. Without it, npm install never triggers and all tests fail
with ERR_MODULE_NOT_FOUND. The stage prompt says "write files" but doesn't
specifically prompt the model to write package.json when it uses packages not
in Node.js core. Consider adding a system-prompt reminder or a sensor that
detects a bare import with no matching package.json entry.

### lang:node dynamic import inside describe() causes parse failure
Phase-256 ambitious dogfood: model wrote `const http = await import('node:http')`
inside a `describe()` callback body. Top-level `await` outside async functions is
illegal — the module fails to parse with SyntaxError. All static imports from
`node:*` should be at the module top level. Add a pitfall note: dynamic `await
import(...)` inside a function body is a SyntaxError; use a static top-level
import instead.

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
