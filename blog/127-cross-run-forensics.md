# Phase 127: From One Run to the Whole Archive

`kodr why` answers "what happened in *this* run?" — it walks one run's pipeline
from context assembly to final outcome and names the step that broke. It has been
the right tool for debugging a single failure since phase 106. But every run
leaves a `summary.json` behind, and after a few hundred runs that directory is
the most honest record kodr has of how it actually performs. Nobody was reading
it as a whole.

`kodr trends` reads it as a whole.

## What it answers

Point it at `.kodr/runs/` and it aggregates every `summary.json` into one report:

```
Cross-run trends — 67 runs
  ok           36/67 (54%)
  proposal     40/67 (60%)
  applied      21/67 (31%)

  failures by step:
    verification-failed  12
    write-error          11
    other                6
    no-proposal          2

  by model:
    nvidia/nemotron-3-nano-omni        8/30 ok (27%)
    qwen/qwen3.6-35b-a3b               14/21 ok (67%)
    mistralai/devstral-small-2-2512    0/1 ok (0%)
```

That is the repo's own archive, and it says things no single `why` could. The
gap between proposal (60%) and applied (31%) is where extraction and write land
or don't. `verification-failed` and `write-error` are neck and neck as the
dominant failure steps. And the per-model ok-rate is a free, retrospective
routing signal — nemotron lands a quarter of its runs, qwen two-thirds — computed
from history rather than guessed.

## Attribute each failure once

The one design decision worth calling out is failure attribution. A failed run
often looks broken at several layers at once — no proposal *and* no tests *and*
not ok. If you tally every symptom, the histogram double-counts and stops meaning
anything. So `classifyRunFailure` walks the pipeline in order and stops at the
*earliest* break: no-proposal before write-error before verification-failed,
and so on. Each failed run contributes exactly one bar. The histogram sums to
the failed-run count, which is the only way it reads as "where do runs die."

The phase-125 heal stop reasons fall out naturally here — `nothing-generated`
and `wrong_path_exhausted` are their own failure steps, so the goal-substitution
guard's effect will show up in trends as those buckets shrink.

## Cheap by construction

There is no new artifact and no schema change. `summary.json` already carries
`ok`, `proposalFound`, `applied`, `tested`, `healed`, `healStopReason`, `model`,
`usage`, `transport` — everything the report needs. Old runs aggregate without
migration; a partial or aborted run with a missing or unparseable summary is
skipped rather than fatal, because an archive that accumulates over months will
always have a few of those. The whole module is a tolerant directory scan, a
reducer, and a formatter.

That is the shape this arc keeps returning to: the expensive part — running real
models hundreds of times and recording what happened — was already done and
already on disk. The leverage is in reading it. `kodr why` read one run;
`kodr trends` reads them all, and turns a pile of timestamps into a feedback
instrument you can point at the next decision.
