# Phase 28: CSV Expense Regeneration

The goal of this phase was to make the CSV example stop looking like a mixed manual fixture. Instead of asking the model to rewrite the whole app again, Kodr used the new patch proposal path from Phase 27 and kept every attempt in provenance.

The first patch prompt was still too broad: it asked for a source change and a test change together, and the model returned one valid patch plus one malformed patch. Kodr now records invalid proposal artifacts, so that failure left a summary, response, writes file, and task state.

The next source-only prompt showed another patch ergonomics issue. The model got the right target but drifted whitespace in the search text. Kodr now has a conservative whitespace-tolerant fallback that only applies when a same-line-window match is unique.

With those harness fixes in place, three streamed Kodr patch runs succeeded:

- source parser validation for non-string CSV input
- native `node:test` coverage for that validation
- README and sample CSV refresh

This is a better example provenance story than a manual redo. The sample still teaches the same CSV parser and CLI behavior, but its current changes are backed by successful Kodr runs and the failed runs explain why the harness gained stricter artifact handling and more practical patch matching.
