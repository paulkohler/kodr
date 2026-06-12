# Phase 115 — Structural Decode-Artifact Rules

Three runs out of three. Every time gpt-oss-20b wrote a two-file proposal, the same byte was wrong at the same structural position. The envelope was otherwise perfect — the right keys, the right values, working code. One character stood between a successful run and a silent failure. This phase writes the rules that insert it.

## The corruption taxonomy

Phase 112 added the first decode-artifact rule: `<|"|>` → `"`. It fixed gemma's habit of emitting its special-token delimiters as literal pseudo-tokens inside JSON strings. One rule, one model family, one failure class.

Phases 113 and 114 added two more failure classes.

**gemma role-B collapse.** In some response turns, gemma collapsed `"key":"` into `"key:<|"|>`. The blanket rule transforms this into `"key:"` — the colon is now inside the key string, the value's opening quote is gone, and parsing still fails. The fix requires knowing the structural context: `"key:<|"|>` → `"key":"`. This rule must run before the blanket rule.

**gpt-oss array-boundary corruption.** Three times in three runs, the `files[]` array boundary was corrupted. Not random noise — deterministic, per-model, one character off in one of two shapes:

- `"},{"path":` should be `},{"path":` — a stray `"` before `{` (phase-113 baseline)
- `"},"path":` should be `},{"path":` — the opening `{` simply missing (phase-114 iterations 1 and 2)

Each run produced a different shape. Same position in the document, different single-character error. The model is emitting the array-element boundary token incorrectly, consistently, as a deterministic function of some hidden generation state.

## The three-for-three story

The phase-113 baseline gpt-oss run: `},"{` — stray quote before the brace. One character manually removed: working proposal, functional CLI (graded D, but functional). Logged as a harness defect, queued for a structural repair rule.

The phase-114 iteration 1 run: `},"path":` — the `{` missing entirely. Different from baseline. Same position, different omission. Phase 114 prompt iteration aimed at gemma; gpt-oss just happened to run too and showed a second corruption shape.

The phase-114 iteration 2 run: same missing-brace pattern, same position. Three runs, two distinct shapes, zero successful completions.

All three failures had something in common beyond the corruption: gpt-oss called a nonexistent `write_file` tool 4–5 times per run despite an explicit prompt line saying there was no write tool. The error feedback said "unknown tool" and stopped. It did not redirect. The model tried again.

## The repair architecture

The repair rules are structural — they operate on the JSON text before parsing, pattern-matching byte sequences that are unambiguous corruptions. The risk is false positives: `},{"path":` inside a legitimate string value would be corrupted by R2b. The gate is parse failure.

For each candidate text, the repair path is:

1. Apply blanket rules (safe, unconditional — these replace known pseudo-tokens regardless of context).
2. If parse fails: apply structural rules + blanket rules. Now it is safe to apply structural rules because we have already established that the text, as-is, does not parse.

There is one exception. The R2 boundary corruptions (gpt-oss patterns) can prevent `braceWalkFrom` from generating any candidate at all — the stray `"` puts the brace-walker into string mode at the wrong level, and the walker exits or throws before reaching the closing `}`. When the first pass yields zero envelopes, the extractor applies structural rules to the full text and re-enumerates candidates. This is still the repair path; zero envelopes is the gate.

A test proves the false-positive bound: a valid envelope containing `},{"path":` inside a string value round-trips without modification. The string lives inside a key-value pair that parses cleanly; the structural repair path is never entered.

## R3: repair forensics

`_extractionMeta` now carries a `repairs` array of `{ruleId, count}` entries when rules fired. Each entry names the rule and how many times it matched. This sits alongside `candidateCount`, `proposalCount`, and `merged` in the existing meta object. It does not yet flow into `summary.json` or `kodr why` — that's a separate NEXT.md item — but it makes the repair activity visible in replay output and tests.

## R4: unknown-tool steering

The unknown-tool error previously said `Unknown tool: write_file` and stopped. The model had no information about what tools did exist, and no reminder that the write path was the JSON envelope.

The new error mirrors the phase-109 allowlist-hint pattern: it names every valid tool in the registry and restates the envelope contract. Terse, imperative, in the same voice as the run_command hint that already steers models away from trying to write files via shell commands.

## Rule ordering is a contract

The `DECODE_ARTIFACT_RULES` array is exported. Tests verify that `gemma-collapsed-key` appears before `blanket-quote-token` in the array, and that all structural rules precede all blanket rules. The ordering is not incidental — running the blanket rule first on `"content:<|"|>` produces `"content:"` (unparseable), not `"content":"value"` (correct). The rule list is a protocol, not a bag of substitutions.

## Offline replay

Four saved raw responses from phases 113 and 114 are now fixture files in `test/fixtures/`. The offline replay tests feed the exact bytes that failed in production through `extractProposal` and assert the expected file paths are recovered. This is the strongest validation available without a live model — the same bytes, the same code path, no approximation.

The gemma fixture recovers `logstats.mjs` but not `test/logstats.test.mjs`. That block's content string contains JavaScript with `"json"` inside single-quoted strings, which creates unescaped `"` characters that break JSON parsing even after structural repair. The R1 rule fires (5 times, recorded in `repairs`), and the blocks where repair is sufficient are recovered. The block that cannot be recovered after repair is a pre-existing limitation, not a regression.

## Validation finding: devstral and the empty arguments crash

A new model's first run produced a new failure mode.

`mistralai/devstral-small-2-2512` called `list_files` on turn 1, which has no arguments. Instead of emitting `arguments: "{}"` — what every other model sends — it emitted `arguments: ""`. An empty string.

The harness placed that tool_call verbatim into the conversation history and sent it back to LM Studio on turn 2. LM Studio returned HTTP 500.

A proxy intercepted the request, patched `""` to `"{}"`, and replayed it. HTTP 200. The model's output was wrong; the wire was fine; the fix was purely local to message assembly.

The repair is one function: `normalizeToolCallArguments()`, called when the assistant tool_calls message is pushed into history. Empty string, null, and missing arguments all become `"{}"`. The dispatch path already had this covered — `argsJson || '{}'` — but dispatch parses arguments for tool execution, not for conversation history. The two paths are correctly separate. Dispatch tolerates `""` locally. History must not emit it.

The artifact is preserved. `raw-response.json` is written from `chatResponse.body` before any message assembly happens. The model's actual bytes stay on disk; only the outbound request body is corrected. This is the same principle behind every decode-artifact rule: never lie to the record, only fix the wire.

Three phases of structural rules had established a pattern: models emit unexpected bytes, the harness breaks, a narrow targeted repair restores the round-trip. devstral's first contribution was a fourth variant — not in the response content, but in the tool_call arguments field itself. Same pattern, different slot.
