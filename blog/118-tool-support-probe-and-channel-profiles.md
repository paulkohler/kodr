# Phase 118 — Tool-Support Probe And Channel Profiles

Phase 117 handed the three models a declared `write_file` tool and watched three different things happen. gpt-oss used it immediately — every file through tool args, zero envelopes to corrupt. Gemma ignored it and kept its envelope discipline as before. Qwen — from LM Studio's natively-tool-supported family — declined the tool channel entirely and then collapsed both files[] objects into a single object literal with duplicate `path` keys, a failure class we'd never seen and had no repair rule for.

Three models, three distinct behaviours, same declared tools. Phase 117's bet was additive; the evidence it returned confirmed what the arc's theory predicted: reliability is a property of the (model, server, template) triple. Phase 118 measures it.

## What the probe now does

`kodr probe` has always checked connectivity and first-token latency. It now does two more things.

**Tool-support classification.** The probe sends a minimal chat completion with one trivial declared tool — `probe_echo {value}` — and a user message that requires calling it. Three outcomes:

- Structured `tool_calls` in the response body: `native`. LM Studio's chat template formatted the tools array into the prompt AND parsed the model's tool-call syntax back into structured output. The constrained channel is available.
- No `tool_calls` but tool-call-like syntax in the text content (`<tool_call`, `"function"`, fenced JSON naming the tool): `fallback`. The model is trying to use tools; the server's parse layer isn't wiring them up. The model's inclination is there but the infrastructure isn't.
- Neither: `none`. The model doesn't use the declared tool at all.

The probe records a short evidence snippet alongside the classification — the first 120 chars of the relevant text or the raw tool-call structure — so the human output gives you something to read, not just a verdict.

**Management API facts.** For LM Studio base URLs, the probe also queries the management API (`GET <host>/api/v1/models`). It reports per-instance: `context_length`, `parallel`, and `capabilities.trained_for_tool_use`. Crucially, it warns when the loaded `context_length` differs from the profile's assumed context window. The GUI loads models at 8,192 by default; kodr profiles assume 32,768. This mismatch bit us twice in validation runs and was diagnosed only by inspection. Now it's a probe warning.

Non-LM Studio base URLs skip the management API silently. A missing or unreachable management endpoint degrades to a note in the output — it never fails the probe.

## Persistence: probe.json

Probe results persist to `.kodr/probe.json`, keyed by `(baseUrl, model)` composite key with a timestamp. Same pattern as `.kodr/routing.json` from phase 105 — small, merge-on-write, no lock contention in typical use.

This is the coupling between measurement and channel selection. `applyModelProfileDefaults` loads probe.json synchronously (matching the sync profile-resolution path) and feeds it into `resolveToolWritesMode`.

## Channel profiles: toolWrites

Model profiles gain `toolWrites: 'native' | 'envelope' | 'auto'` (default `'auto'`). The value resolves through `resolveToolWritesMode` and lands in options as `toolWritesMode`. It flows through context-packer into the prompt, and into the tool registry, and into `summary.json` so forensics can correlate channel choice with outcomes.

- `native`: capture tools declared in the registry. Prompt wording makes them primary. The final envelope carries status and messages only; the files/patches arrays may be empty.
- `envelope`: capture tools NOT declared. Pre-117 surface. For models the measurements say are confused or degraded by declared tools.
- `auto`: neutral 117 wording (both channels, no primary). When probe.json records `toolSupport: 'native'` for the exact (baseUrl, model) pair, auto resolves to `native` at session start.

The resolution is explicit: `fallback` and `none` probe results don't change the mode. Only a confirmed `native` classification promotes auto to native. Ambiguity stays in neutral.

## Channel-aware prompt wording

Phase 114 established the lesson: prohibitions are worse than silence; positive contract beats steering. Phase 118 extends it across modes.

For `native`: "Use `write_file` or `edit_file` for every file change. The final JSON envelope carries status and messages only — files/patches arrays may be empty." The tools are the primary channel; the envelope is demoted to a status carrier.

For `envelope`: the tools block contains no `write_file`/`edit_file` lines at all. The pre-117 prompt surface, identical to what models like gemma have been generating against reliably.

For `auto` (unresolved): unchanged 117 wording — both channels mentioned, neither primary.

The wording change is byte-stable within a session (mode is fixed at start), so prompt-caching still applies. The budget guard was updated to account for the native-mode wording, which is slightly longer than auto, and stays comfortably under the 3,200-char guard.

## T5: the duplicate-key-cluster split rule

The qwen failure was a structural compression: `{"path":"a.mjs","content":"...","path":"b.mjs","content":"..."}` — both files' key-value pairs inside one object literal. Phase 115's gpt-oss rule repaired missing object boundaries; this is the inverse problem.

A naive regex can't detect this safely — it can't distinguish a key occurrence in a string *value* from one at the object level. The repair rule (`applyDuplicateKeyClusterRule`) uses a position-aware character scan tracking string/escape state and object depth (arrays are transparent; only `{`/`}` drive the depth counter). At each depth level it maintains a key set. When a key already seen at the current depth appears again, the scanner injects `},{` at that point and resets the key set for the new object.

The rule goes into `DECODE_ARTIFACT_RULES` as a structural rule, between the gpt-oss structural rules and the blanket rules — same ordering philosophy as phase 115. Its `ruleId` (`qwen-duplicate-key-cluster`) is recorded in `_extractionMeta.repairs` when triggered.

False-positive guards: a test proves that `,"path":` appearing inside a string *value* is untouched (the scan is in-string at that point). A second test proves that legitimately different objects with the same key don't trigger it (the key set resets on depth transitions, not within a single object entry sequence).

The offline replay test reads the real qwen response from `test/fixtures/qwen-duplicate-path-key.txt` — 8,362 bytes of actual model output, copied verbatim from the phase-117 run. Both `wordfreq.mjs` and `test/wordfreq.test.mjs` must be extracted with the correct paths. Either the adoption question (does tools-primary wording move qwen onto the capture channel?) or the extraction question (does the split rule rescue qwen's envelope output?) validates the phase. The test proves the extraction path is ready.

## What changed in tests

1,158 tests pass, up from 1,095 before phases 117–118. The new tests cover:
- T1 classification: fake server returning structured tool_calls / leaked syntax / plain text → native / fallback / none with evidence snippet
- T2: management API response fixtures; context_length mismatch warning; unreachable API → note; non-lmstudio skips silently
- T3: probe.json write/read round-trip; merge on subsequent saves; auto resolution with and without measurements; envelope mode declares no capture tools; toolWritesMode in summary
- T4: prompt assembly per mode — native primary wording / envelope clean / auto neutral — byte-stable, under budget
- T5: rule unit (simple two-key duplicate split); no-false-positive (string value, sibling objects); ordering in DECODE_ARTIFACT_RULES; offline replay of the real qwen bytes

## The qwen adoption experiment

The live validation question: send qwen a `kodr probe` and read what it returns. If it returns structured `tool_calls`, its triple is `native` — auto resolves, tools-primary wording kicks in, and the next greenfield run tests whether it uses the constrained channel. If it returns syntax in text, it's `fallback` — it's trying, the server isn't wiring it up, and the T5 repair rule is the right safety net. If it returns neither, it's `none` — envelope mode is the measured answer.

Either outcome is valid evidence. The phase is designed so both paths are ready.
