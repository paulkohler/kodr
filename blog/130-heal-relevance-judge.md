# Phase 130: Healed, or Just Green?

Phase 125 named the heal loop's worst sin — reporting `healed` for the wrong
goal — and fixed two of its three forms. The repair prompt learned the original
task, and a run that generated nothing got refused entry to the loop instead of
inventing its way to a pass. One form was left standing, and it was the subtle
one: a heal that writes *something*, just not the right something.

The loop's own code admits the gap. When verification passes, the run is healed,
full stop — `if (verification.ok) stopReason = 'healed'`. There's even a comment
a few lines up at the wrong-path check conceding it: a wrong-path write that
passes tests is healed. Which is fine when the test measures the task. It is not
fine when the model, handed a failing run, writes a brand-new unrelated module
with its own little passing test and the suite goes green on that. Verification
is ground truth, and ground truth just certified the wrong thing.

## The signal was already there

Phase 125 put the original task into the repair context for a different reason —
to stop the repair *drifting*. But that same task text is exactly what you need
to judge a passing heal after the fact. Two questions decide it:

1. Did the writes that made it pass touch any *known* path — a failing test
   file, or a source the loop showed the model? The loop already computes this
   (`touchesKnownPath`).
2. Do any of the written paths — or their basenames — appear in the original
   task text? That's the new `writesReferenceTask`.

If both answers are no, the heal passed by touching nothing it was supposed to
touch and nothing the task asked for. That's a suspected goal-substitution. If
*either* is yes — it fixed a known file, or it created a file the task explicitly
named — it's cleared. A task that says "create wordcount.mjs" and a heal that
writes `wordcount.mjs` is a legitimate repair, not a substitution, and the
basename match exonerates it.

## Flag, don't fail

The deliberate choice here is restraint: the judge records
`goalSubstitutionSuspected` and stops. It does not flip the run to failed.
Verification passing still means something, and a false positive that turned a
real fix into a reported failure would be worse than the disease — exactly the
trap phase 124's null warned against, where the easy move is to over-trust a
signal. So the suspicion is surfaced, not enforced: a warn step in `kodr why`'s
Healing phase, a field in the summary, and a ⚠ counter in `kodr trends` so a
pattern of suspect heals shows up across the archive rather than one run at a
time.

That last part is why this lands now and not in 125. Phase 127 and 128 built the
aggregate view; phase 129 made it windowable. A single suspect heal is noise. But
`kodr trends` reporting "⚠ suspected goal-substitution heals: 6" over a window is
a signal you can act on — it says the heal loop is papering over generation
failures often enough to investigate, with `kodr why` ready to show you which
runs and what they invented. The judge produces the flag; the forensics arc makes
it legible. The trust guarantee now has a tripwire instead of a blind spot.
