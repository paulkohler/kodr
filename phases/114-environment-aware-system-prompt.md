# Phase 114 — Environment-Aware System Prompt

## Motivation

Kodr's system prompt is 1,737 chars: an identity line, the envelope contract,
one run-on sentence naming all seven tools, and the workspace file list. It
tells the model nothing about where it is (cwd, OS, shell, git state, Node
version), nothing about its own identity (model id), and nothing about
behaviours we now have three dogfooding rounds of evidence the models need.

Picked apart from a frontier-harness system prompt, three sections transfer:

- **Environment** — deterministic facts that prevent whole classes of
  generated-command failures: zsh vs bash quoting, ESM/Node-24 targeting,
  relative-path mistakes, git assumptions.
- **Behaviours** — but only lines that map to *observed* kodr failures
  (`process/failures.jsonl`), not aspirational prose. Multi-block narration,
  goal substitution, repeated identical tool calls, and turn-budget
  exhaustion all have one-line prompt-side defenses.
- **Tools** — per-tool "when to use" lines and a workflow ordering beat the
  current run-on sentence; the model should also know its turn budget exists
  before the forced final turn teaches it.

What does NOT transfer: security-policy paragraphs, model catalogs,
memory-file systems (the scratchpad contract already covers it), and most of
all the *length* — local 20–35B models degrade with prompt bloat. Budget:
the three new sections together stay under ~900 chars. Every line cites an
evidence entry or a concrete failure class in the phase review; anything
that can't is cut.

## Work items

### P1 — Environment block

New pure function (e.g. `renderEnvironmentBlock(facts)` in a small module)
producing a compact section:

```
# Environment
- cwd: /path/to/workspace
- git repository: yes (branch main) | no
- platform: darwin (Darwin 25.5.0), shell: zsh
- node: v24.16.0
- date: 2026-06-12
- model: google/gemma-4-26b-a4b
```

Facts are gathered once per run from `io`/`process` (no shelling out except
a cheap git check; reuse existing git helpers from phase 94 if present).
Within a session the block is byte-stable (date and git branch captured at
session start) to preserve prompt-prefix caching (phase 87).

### P2 — Behaviours block

A short `# Behaviours` section, each line traceable to evidence:

- Return exactly ONE JSON envelope per response. Never narrate a sequence of
  JSON blocks. (gemma multi-block narration, 111/113-dogfood)
- If verification or tests fail, say so in messages — never claim success.
  (goal-substitution heal, 113-dogfood)
- If a tool call fails or returns nothing useful, change your approach — do
  not repeat the identical call. (repeat-call short-circuit, 109)
- When you have enough information to write the proposal, write it — do not
  keep exploring. (turn-budget exhaustion, 109)

Exact wording is the implementer's call; keep it terse and imperative.

### P3 — Tools block

Replace the run-on tool sentence with one line per tool ("`read_file` — raw
file text; read before you patch") plus a workflow line (inspect → read →
patch/files → verify) and a budget line ("You have a limited number of tool
turns; finish with the envelope before they run out."). Only when tools are
enabled — the no-tools prompt must not mention them (it already varies by
path; follow the existing structure in edit-formats.mjs /
renderKodrBaseContract and keep the patch-format byte-stability promise:
update the places that assert byte-identical text together).

### P4 — Assembly, stability, artifacts

The new sections join the stable prefix in most-stable-first order (identity
+ envelope + behaviours + tools, then environment, then per-run workspace
listing stays last/variable). `prompt-prefix.json` and prefix-stability
tests updated; `kodr run --show-config`/`--show-context` surfaces should not
break. The total system message for the standard greenfield task must stay
under ~2,900 chars (current 1,737 + budget ≤ ~900 + slack); add a test that
guards the budget so the prompt cannot silently bloat in future phases.

### P5 — Live A/B validation (run separately after the commit)

Old prompt vs new prompt on the standard wordfreq greenfield task, both
models (`google/gemma-4-26b-a4b`, `openai/gpt-oss-20b`), sequential,
redirected. Compare: run success, proposal extraction, response shape
(blocks, artifacts), prompt tokens, and generated-code quality. The phase is
only validated if the new prompt is no worse on success rate and shows at
least one observable improvement (e.g. fewer narration blocks, correct
shell/Node assumptions in generated commands).

## Testing

- Unit tests for `renderEnvironmentBlock` (git/no-git, fact formatting,
  byte-stability across two calls in one session).
- Prompt assembly tests: sections present/absent per mode (tools vs
  no-tools, edit formats), order stable, budget guard test.
- Existing prompt-prefix stability tests stay green (update fixtures
  deliberately, not incidentally).
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [ ] P1: environment block rendered with real facts, byte-stable per
      session, in the stable prefix.
- [ ] P2: behaviours block, every line traceable to a failures.jsonl entry.
- [ ] P3: per-tool lines + workflow + budget line, tools-mode only.
- [ ] P4: prefix stability preserved; prompt budget guard test in place.
- [ ] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [ ] Blog post `blog/114-environment-aware-system-prompt.md`.
- [ ] NEXT.md entries shipped by this phase deleted (FIFO), if any apply.
- [ ] Version bumped to 0.0.114; suite green; committed.
- [ ] P5: live two-model A/B validation recorded (run after the commit).
