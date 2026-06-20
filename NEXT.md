# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

## Current frontier (phase 230)

`kodr check` is a complete standalone diagnostic — `--json`, `--strict`,
`--changed`, `--watch`, `--deep`, `--ci`, `--fix`, and a path argument — over
eight cross-reference sensors (canonical `SENSOR_NAMES` / `SENSOR_SEVERITY`
registry). `kodr hook install/status/uninstall` gate commits and pushes on it,
with `.kodr/config.json` `hooks`/`sensors` blocks for per-project tuning.
Per-phase detail for this surface and everything before it lives in
`roadmap.md` and `blog/` — not here.

The live work is the **staged execution pipeline** (`runStagedPrompt`) and
the `lang:node` builtin skill. Phases 213–230 chipped at both for local
thinking models (qwen3.6): pending-write `run_command` guards, W3 draft
fallback, `SafeWriteError` steering with `clearFiles`, raised `maxStageWrites`
(8) with unique-path dedup, inter-stage `npm install`, the phase-224
`safeWriteSteered` flag, the phase-225 zero-applied-write auto-advance, the
phase-226 duplicate-block guard in `preparePatches` (`reason: 'duplicate_block'`),
the phase-227 `lang:node` pitfall trio (node:sqlite `DatabaseSync` import
name, check-status-before-parse, module-scope side effects), the phase-228
profile-aware heal per-turn timeout (wireNoStream profiles now get the full
main-loop budget instead of the D2 240s cap), the phase-229 staged-aware
`run_command` / turn-exhaustion guard wording (three sites made staged-aware so
the model no longer receives envelope-only or factually false instructions in a
staged run), and the phase-230 per-test timeout for pm-delegated `node --test`
verification (scoped rewrite of `npm test` / `pnpm test` / `yarn test` to
`node --test` when `scripts.test` is a bare `node --test`, so the existing
`--test-timeout` injection applies and one hung generated test fails fast).

## Candidates

### Staged completion: synthetic user turn instead of embedded tool hint
Phase-223 dogfooding: embedding STAGED_DONE JSON in a tool-error message does not
reliably break the model's tool-calling loop. The model needs the completion
instruction delivered as a clean user turn (not buried in error JSON). When the
staged sentinel escalates (count >= ESCALATION_THRESHOLD) and inStagedPipeline
is true, inject a synthetic user message after the tool result — e.g., appended
to the `messages` array before the next iteration — that says:
"All target files are written. Stop calling tools. Return only:
`{\"status\":\"OK\",\"files\":[],\"messages\":[{\"level\":\"info\",\"content\":\"STAGED_DONE\"}]}`"
This is architecturally different from Phase 223's tool-error approach: it sends a
user-role message that the model must respond to, rather than a tool result it may
ignore. Needs careful placement in completeWithToolCalls so it fires after the tool
result is appended but before the next request.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own.

### llms.txt doc-lookup pattern for skills
When a skill covers a library or API with online docs, encode a `llms.txt`
index URL as the fallback documentation source. Pattern observed in
google/gemma-skills: if an MCP search tool is available use it; else fetch
`https://<domain>/llms.txt` to discover available pages, then fetch specific
pages as needed. A general direction: add a `## Documentation` section to any
builtin skill that has a known `llms.txt` (Express, SQLite, busboy, etc.) so
the model has a live path to current API docs when its training data is stale.
Note: kodr has no external skill registry yet — this applies only to builtin
skills as they are added.

### Smoke-as-verification in the heal loop
Phase 184 wired a smoke-driven second heal pass, but the in-loop verification
still uses `options.testCommand`. When no testCommand is set, smoke failures
can't drive repairs. Full smoke-as-verification requires pluggable verification
backends: callers pass a `verify` function instead of a `testCommand` string.
Significant architecture change — not yet plannable without an interface sketch.

### Heal-turn empty completions: reasoning-token runaway on wireNoStream models
**Decisive root cause, from the 2026-06-20 ambitious final-audit dogfood
(`final-audit/blog-platform`).** Heal turns on qwen3.6 (wireNoStream) fail because
the model **burns its entire completion budget on reasoning tokens and hits
`finish_reason: "length"` with ZERO answer content** before it ever emits a
repair. Raw evidence from a heal turn's `raw-response.json`: `content` length 0,
`reasoning_tokens` 21,691, `total_tokens` 32,768 (= the profile `contextWindow`),
`finish_reason: "length"`. The model reasoned until it exhausted the 32K window
and was cut off mid-thought. The profile sets `maxThinkingTokens: 4096`, but the
wire produced 21,691 reasoning tokens — **so that cap is NOT being honored on heal
requests** (kodr may not send it, or LM Studio ignores it for this model).

This supersedes BOTH earlier framings, which were wrong: (1) "context overflow /
accumulated turn-log" — the heal prompt is built **fresh** (`renderLoopRepairPrompt`
= tests.json + repair-context files) and the prompt here was only 11,075 tokens;
(2) "the heal turn just needs more wall-clock time" — phase 228 raised the cap
240s→600s, yet these turns returned at ~335s (well under 600s) with empty content.
There are two distinct failure modes and the data conflated them: **(A) client
timeout** — the older 240s cap aborted a still-generating request (`durationMs ==
240000`); **(B) reasoning runaway** — the model returns `finish_reason: length`
with 0 content because reasoning ate the whole window. Phase 228 fixed (A) (heal
budget == main budget) and, usefully, **let (B) become diagnosable** by running the
request to its natural finish instead of an opaque abort. But (A) was largely a
symptom of (B): give the runaway more time and it still returns empty.

**Primary direction (new, highest confidence):** cap the heal request's
reasoning/completion budget so the model MUST leave room for an answer. Options to
investigate: enforce `maxThinkingTokens` on the wire (find why 4096 isn't applied —
does the heal path send it? does LM Studio honor a thinking cap or need
`max_tokens`/`reasoning_effort`?); or send a `max_completion_tokens` that reserves
answer room under the 32K window; or detect `finish_reason: "length"` + empty
content and retry with a tighter thinking budget. Deterministically testable once
the honored wire param is identified — the request builder is a pure function.
**Secondary:** (b) trim the heal prompt's verbatim file embeds (one prompt embedded
a 228-line test file) — frees window for reasoning+answer, marginal on its own;
(c) stream heal turns so a partial answer survives and the runaway is detectable
early (still useful, but the token cap is the real lever). Note heal frequency has
dropped (staged maturity + phase-227 skill mean complex tasks often pass
first-pass), so this bites less often — but when a hard repair IS needed, it
reliably produces nothing. Evidence: `final-audit/blog-platform` heal
`raw-response.json` + `turn-meta.json`, and heal `turn-meta.json` across
phase-201/204/216/219/225/226/228 runs in `~/src/kodr-testing`.

