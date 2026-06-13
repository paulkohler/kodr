# Phase 131: Let the History Pick the Model

Phase 105 built a routing table — a recommendation of which model to use for
edits versus cheap tasks — and then, sensibly, didn't wire it to anything. It was
computed from a bench run, sat in a file, and waited for a `/model auto` that the
blog post promised "in the future." The future kept not arriving because the
table was advisory and nobody had a reason to act on it.

Then phases 127 and 129 produced a better version of the same signal, almost as a
side effect. `kodr trends` already reports per-model ok-rate across the run
archive, and it's windowable. That's not a synthetic bench score — it's how often
each model actually landed a run in real use. In the repo's own archive the
spread is stark: qwen lands two-thirds of its runs, nemotron barely a quarter.
When the data is that lopsided, "which model should I use for edits?" stops being
a guess.

## The command

`kodr route` reads the archive, ranks the models by ok-rate, and names one:

```
Recommended edit model (by run-history ok-rate, ≥3 runs):
  → qwen/qwen3.6-35b-a3b

  candidates:
    qwen/qwen3.6-35b-a3b               14/21 ok (67%) *
    nvidia/nemotron-3-nano-omni        8/30 ok (27%)
```

Two design choices make it trustworthy rather than noisy. First, a minimum run
count — a model with one lucky 1/1 run must not outrank a model with a solid
14/21, so anything under `--min-runs` (default 3) is excluded, along with the
`unknown` bucket that non-standard run dirs fall into. Ok-rate ranks; run count
breaks ties, so the better-evidenced of two equal rates wins. Second, it's
advisory by default. Plain `kodr route` only prints; nothing changes until you
ask.

## Opt-in activation

`kodr route --apply` is where the table from phase 105 finally activates, just
from a different signal. It merges the recommended `model` into
`.kodr/config.json` — read, set `model`, write back — preserving every other key
and never touching the gate keys that config writes aren't allowed to set. Run it
and your project default becomes the model your own history says works best. Run
it again next week and it tracks whatever the recent runs show.

That's the whole activation: not an automatic mid-run model switch (which would
be a much bigger and riskier change), but a one-command "set my default to what's
working," backed by evidence I already have. The cheap, honest version of routing
turned out to be the one the forensics arc had been quietly assembling — the
archive knew which model to use; this phase just asks it.

## What it isn't

This routes the *default* model, not per-task selection — there's no automatic
"summaries to the cheap model, edits to the strong one" yet, which is the larger
ambition phase 105 sketched. And a recommendation from history is only as good as
the history: a model you've run three times on easy tasks will look better than
it is. `--min-runs` blunts that but doesn't erase it. The recommendation is a
starting point you can act on with one flag, and re-check whenever the archive
grows — which, for a tool whose whole thesis is measuring itself, is exactly the
right shape.
