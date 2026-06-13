# Phase 133: The Other Half of the Record

There are two ways kodr measures itself, and until now only one of them was
readable.

The first is the live run archive — every real run leaves a `summary.json`, and
phases 127 through 132 turned that pile into an instrument: rates, failure
histograms, per-model ok-rate, windowed before/after, a routing recommendation,
an HTML dashboard. The second is the eval suite. `kodr eval --record` runs a
fixed set of scored cases against a model and appends one line per run to
`evals/results/<suite>/<model>.jsonl` — a controlled, repeatable score, exactly
the kind of thing you want when "did this change help?" needs an answer that
isn't confounded by which tasks happened to come up.

But that append-only file was write-only. The runner wrote scores into it and
nothing ever read them back. `kodr evals` reads them back.

## What it shows

Point it at `evals/results` and it groups every recorded line by suite and model,
orders them by time, and shows the trend:

```
Eval score trends (per suite × model):

  code-quality
    openai/gpt-oss-20b                 100% latest (2 runs) ██ (0pts)
```

Latest score, how many times the suite has run against that model, a sparkline of
the scores over time, and the first→latest delta. The sparkline is the eval
analog of the run archive's before/after comparison — a glance tells you whether a
model's score on a suite is climbing, flat, or sliding across recorded runs. Run
the brownfield suite against three models over a month and this is where you'd see
which one is actually getting better as the harness changes underneath it.

## The same posture, twice

This is deliberately the same shape as `kodr trends`: a tolerant read-only scan
of artifacts that already exist, pure aggregation functions, a compact renderer,
and graceful handling of a missing directory or a junk line. The eval results and
the run summaries are different measurements — one controlled, one in-the-wild —
but they're now both readable the same way, which was the point. The suite tells
you what a model scores on a fixed bar; the archive tells you how it does in real
use; together they're the two halves of "how is this thing actually doing," and
neither was meant to sit unread on disk.

That closes the forensics arc that ran from 127 to here. What began as `kodr why`
explaining a single run is now a small, coherent measurement surface over
everything the harness has ever done — runs and evals alike. The expensive part
was always producing the data. These phases were cheap because they just kept
finding it already there, waiting to be read.
