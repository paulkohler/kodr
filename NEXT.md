# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 242)

`kodr check` is a complete standalone diagnostic. The staged execution pipeline
(`runStagedPrompt`) and `lang:node` builtin skill have been hardened through
phases 213–242: reasoning-runaway fast-fail and heal cap (231/234/236), staged
implement-turn runaway detect-and-retry with `completionCapMode:'staged-retry'`
(240), heal context-overflow retry and `repair_context_overflow` stop reason
(241), terminal surfacing of staged-runaway and heal-overflow events (242). The
`--skill` flag falls through to the builtin registry when workspace discovery
finds nothing (239).

## Candidates

### Include staged plan in heal repair context
Phase-242-audit: the heal model repeatedly hypothesised "database reset" rather
than reading the staged plan where the bug (`r[0]` positional indexing) was
introduced. The plan stage text is written to the run artifact but NOT passed to
the repair prompt. Including it as `plan` in `repairContext` would give the repair
model intent context — especially valuable for staged runs where the plan contains
the root cause.

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
