# Phase 129: Did It Actually Help?

Phase 127 gave kodr a whole-archive view of how it performs. Phase 128 made the
extraction layer show up in it. But the question that has been driving the last
handful of phases — the guidance A/B, the extraction metadata, the heal fixes —
is not "how is the archive doing overall." It's narrower and sharper: *did the
thing I just changed make runs land more often?*

A lifetime ok-rate can't answer that. If the last twenty runs improved and the
prior three hundred didn't, the aggregate barely moves. The signal is real but
the average drowns it. You have to cut the archive at the change and compare the
two sides.

## A cut and a comparison

`kodr trends --since <run-id>` does exactly that. It splits the archive at a run
id — and since run ids are ISO timestamps, "since" is just a lexicographic
boundary — into everything before and everything after, runs trends on the
after-window, and prints the one line that matters:

```
ok-rate  before 49% (59 runs) → after 88% (8 runs)  ▲ +38pts
```

That is the repo's own archive, cut at the start of June. Whether the +38 points
is the recent work or just a small-sample swing is a separate question — eight
runs is eight runs — but now the question is *askable* from one command instead
of eyeballed across two full reports. `--last N` is the same machinery from the
other direction: window the most recent N runs, push the rest to "before",
compare.

## Reuse, don't rebuild

The nice thing is how little this needed. Windowing is a filter over the
summaries that `loadRunSummaries` already returns; `computeTrends` doesn't change
at all — it just runs on a smaller list. The comparison is a four-field diff of
two reports' ok-rates. Three small pure functions — `windowSummaries`,
`computeComparison`, `renderComparisonCli` — and the command wires them to two
flags. No new aggregation, no schema change, no new artifact. The expensive part
(running the models, recording the summaries) was done long ago; phase 127 made
it readable; this phase makes it *comparable*.

## The honest caveat

A before/after delta is a hypothesis, not a verdict — exactly the lesson phase
124's null already taught. Small windows swing; correlation isn't cause; a +38
could be the prompt change or could be that the recent runs happened to be easy
greenfield tasks. What windowing buys is the ability to *see* the delta and then
go ask whether it's real — to point `--since` at the commit before a change and
read the number, rather than guessing. The number starts the investigation; it
doesn't end it. But starting it from one command, on data you already have, is
the whole point of building the archive into an instrument.
