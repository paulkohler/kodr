# Phase 110 — Repair-Loop Discipline

This phase started with a question shaped like an ultimatum: the heal loop had
never produced a useful repair in a real run, so either fix it or remove the
feature. It ended with the loop healing a planted bug in one 4.8-second repair
turn — after peeling three separate root causes off each other, none of which
was the one the phase file predicted.

## What the instrumentation bought

Phase 109's timeouts were undiagnosable because timed-out repair turns saved
nothing. D1 added duration, prompt/completion sizes, usage, and the effective
timeout to every repair entry plus a per-turn `turn-meta.json`; D2 capped the
default repair timeout at `min(--timeout-ms, 240s)` and made a timeout say so
everywhere — summary, `kodr why`, and a CLI line with the `--repair-timeout-ms`
escape hatch. The first measurement immediately falsified the standing theory:
repair prompts were only ~7.5KB, and replaying round 1's "600-second" requests
finished in 12–27 seconds. The stall was not the prompt.

## Three root causes, nested like dolls

**The loop was starved.** The first live heal trial dead-ended in two
five-second turns with zero writes. The repair model's own scratchpad said why:
"Need to read src/math.mjs" — and it couldn't, because repair context only
contained failing-test files and a same-directory sibling guess. In no-tools
mode the model literally cannot see the code it must fix. D6 resolves the
failing test's relative imports into context (capped, workspace-jailed). This
also retroactively explains round 1's wrong-path writes: the model was
patching files it had never seen.

**The loop was poisoned.** With the source file in context, the repair turn
stalled past the new 240s cap — finally reproducing round 1. A direct A/B on
the identical prompt: without `response_format`, 6 seconds and a correct fix;
with the strict json_schema, empty content — every completion token spent as
reasoning. LM Studio's constrained decoding and qwen3.6's reasoning mode do
not mix. Repair turns no longer send `response_format`; the prompt already
demands the JSON envelope and extraction is defensive.

**The loop was blindfolded.** With context and schema fixed, the model
produced the exactly correct patch in 5.8 seconds, the patch applied, the file
on disk was fixed — and the run still said "not healed." The phase-103
wrong-path heuristic treated "didn't touch the failing test file" as wrong and
skipped re-verification on such turns. But fixing the source when the test
fails is the *normal* repair shape; the failing path is the symptom, not the
bug. The loop healed the workspace and couldn't see its own success.

## The design lesson

D3 was planned as a pre-apply gate: reject proposals that target unexpected
paths. The trials disproved the whole category. The settled rule is now in the
code as a comment and in `process/decisions.jsonl` as policy: **verification
is ground truth; path heuristics may steer but never gate.** Writes always
apply, tests always re-run, and wrong-path only warns (then exhausts) when a
turn also failed verification. A regression test pins the case that matters:
a "wrong-path" write that makes tests pass is healed, full stop.

## The verdict

D5 was the user's fix-or-remove mandate. Verdict: **keep.** Heal trials 5 and
6 both healed the planted bug end-to-end — README task applied, tests red from
an unrelated planted bug, one repair turn, tests green, `kodr why` showing all
seven story steps ok including `Healing: healingTurns=1 stopReason=healed`.
The feature was never conceptually broken; it was starved, poisoned, and
blindfolded, and each blindfold only became visible after removing the
previous one. That is the strongest argument yet for the dogfood-first phase
shape: not one of the three root causes was guessable from the phase plan.
