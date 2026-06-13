# Phase 118 — Tool-Support Probe And Channel Profiles

Second phase of the tool-channel arc (NEXT.md "Tool-Channel Arc"; phase 117
shipped the capture tools).

## Motivation

Phase 117 proved three different behaviours against the same declared tools:
gpt-oss adopted `write_file` immediately (corruption class eliminated),
gemma ignored the tools and kept its envelope discipline, and qwen — from
LM Studio's natively-tool-supported family — declined the channel entirely
and failed on a new envelope corruption (both `files[]` objects collapsed
into one object literal with duplicate `path` keys). Reliability is a
property of the (model, server, template) triple, and kodr currently
assumes instead of measures it.

Three deliverables: measure tool support empirically (`kodr probe`), let
profiles choose the write channel from measurements (`toolWrites`), and
repair the qwen corruption class the way 115 repaired gpt-oss's (a
structural rule replayed against the exact bytes that failed).

Evidence: `~/src/kodr-testing/phase-117/OPERATOR-REPORT.md`;
`~/src/kodr-testing/phase-117/greenfield-wordfreq-qwen/.kodr/runs/2026-06-13T01-09-47.682Z/raw-response.json`
(the duplicate-key collapse); `process/failures.jsonl` phase 117-validation;
LM Studio docs `/docs/developer/openai-compat/tools` (native vs fallback
tool support).

## Work items

### T1 — Probe measures tool support

`kodr probe` gains a tool-support check: send a minimal chat completion with
one trivial declared tool (e.g. `probe_echo {value}`) and a user message
that requires calling it. Classify the reply:

- structured `tool_calls` in the response → `native`
- no `tool_calls` but tool-call-like syntax leaked into text content
  (`<tool_call`, `"function"`, fenced JSON naming the tool…) → `fallback`
- neither → `none`

Record the classification plus a short raw evidence snippet. Probe output
(human + `--json`) shows it. The probe call goes through the existing
model-client transport (stream-first, first-token deadline) — no separate
HTTP path.

### T2 — Probe reads the management API

For LM Studio base URLs, probe also queries the management API
(`GET <host>/api/v1/models`, no auth) and reports per loaded instance:
`context_length`, `parallel`, and `capabilities.trained_for_tool_use`.
Warn when the loaded `context_length` differs from the profile's assumed
context window (the GUI loads at 8,192 while kodr profiles assume 32,768 —
this has bitten twice). Non-LM-Studio providers skip this silently; a
missing/unreachable management API degrades to a note, never a probe
failure. (This absorbs the "Probe Reads The Management API" NEXT.md entry.)

### T3 — Probe results persist; profiles choose the channel

- Probe writes its measurements to `.kodr/probe.json`, keyed by
  `(baseUrl, model)` with a timestamp — same spirit as `.kodr/routing.json`
  from bench (105).
- Model profiles gain `toolWrites: 'native' | 'envelope' | 'auto'`
  (default `'auto'`).
  - `native`: capture tools declared AND the prompt makes them the primary
    write path (T4).
  - `envelope`: capture tools NOT declared; the pre-117 prompt surface —
    for models the measurements say are confused by tools.
  - `auto`: current 117 behaviour (both channels, neutral wording) when no
    measurement exists; when `.kodr/probe.json` has a `native`
    classification for the (baseUrl, model), auto resolves to `native`.
- The resolved channel lands in summary.json (`toolWritesMode`) so forensics
  can correlate channel choice with outcomes.

### T4 — Channel-aware prompt wording

For resolved-`native` profiles, the tools block makes the capture tools
primary (positive contract, phase-114 lesson): use `write_file`/`edit_file`
for every file change; the final envelope carries status/messages only —
files/patches arrays may be empty. For `envelope` mode the 117 tool lines
disappear with the tools. `auto`-unresolved keeps 117's neutral wording.
Byte-stability per session preserved (the mode is fixed at session start);
prompt budget guard updated deliberately.

This is the qwen adoption experiment: its profile resolving to `native`
(via probe) plus tools-primary wording is the measured attempt to move it
onto the constrained channel.

### T5 — Duplicate-key-cluster split rule

Structural extractor rule for the qwen collapse, driven by the real saved
response: inside a single object literal, a second occurrence of a key
cluster that already appeared at the same depth (`,"path":` following an
earlier `"path":` in the same object) closes the object and opens a new one
(`…,"path":` → `…},{"path":`) — the structural inverse of 115's
missing-brace rule. Repair-path-only (never touches text that parses),
conservative key charset, ordered with the existing structural rules,
`ruleId` recorded in `_extractionMeta.repairs`. Offline replay: the saved
qwen response must extract both files with the expected paths. A
no-false-positive test proves a valid envelope whose *string values*
contain `,"path":` is untouched, and that legitimately-duplicate keys in
*different* objects don't trigger it.

## Testing

- T1 classification units: fake server returning structured tool_calls /
  leaked syntax / plain text → native / fallback / none; evidence snippet
  recorded.
- T2: management-API response fixtures → context_length mismatch warning;
  unreachable API degrades to a note; non-lmstudio skips.
- T3: probe.json write/read round-trip; auto resolution with and without
  measurements; envelope mode declares no capture tools; toolWritesMode in
  summary.
- T4: prompt assembly per mode (native primary wording / envelope clean /
  auto neutral), byte-stable, budget guard.
- T5: rule unit + ordering + no-false-positive + offline replay of the real
  qwen bytes.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [ ] T1: probe classifies tool support with evidence snippet.
- [ ] T2: probe reports management-API facts and warns on context mismatch.
- [ ] T3: probe.json persistence; toolWrites native|envelope|auto with auto
      resolution; mode in summary.json.
- [ ] T4: channel-aware prompt wording per resolved mode.
- [ ] T5: duplicate-key-cluster split rule, offline replay of the qwen
      response extracts both files.
- [ ] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [ ] Blog post `blog/118-tool-support-probe-and-channel-profiles.md`.
- [ ] NEXT.md entries shipped by this phase deleted (FIFO) — the "Probe
      Reads The Management API" entry and the 117-findings paragraph of the
      arc entry.
- [ ] Version bumped to 0.0.118; suite green; committed.
- [ ] Live validation (after the commit, sequential): `kodr probe` against
      qwen, gpt-oss, and gemma — record each triple's classification and
      management-API facts in probe.json; then a qwen greenfield re-run
      with its measured channel — the adoption question: does
      tools-primary wording move qwen onto the capture tools; if it still
      produces an envelope, does the T5 split rule rescue extraction
      (either outcome recorded; a run that succeeds by *either* path
      validates the phase); gemma quick regression check that its resolved
      mode leaves the envelope path untouched.
