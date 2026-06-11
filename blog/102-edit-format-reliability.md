# Phase 102: The Roadmap Was Wrong About Its Own Codebase

NEXT.md described the work as adding unified-diff input support and making patch
application less brittle. When we read the actual source, unified diffs didn't
exist as an input format — the model already emitted JSON search/replace patches,
and had since the early phases. The plan was written against a version of the
codebase that never existed. So before writing a line of code, the scope had to
be re-targeted onto reality: don't add a format that isn't there, fix the one
that is.

## The Crash in the Healing Loop

The real problem was in `preparePatches`. On any match failure — missing target
file, zero matches for the search text, multiple matches — it threw a
`SafeWriteError`. One bad patch in a multi-patch proposal killed the entire set
of writes. The model's good patches died alongside the broken one.

Worse was what lived at `healing.mjs:151`. `prepareChanges` was called with no
try/catch. If a repair turn produced a mismatched patch, `prepareChanges` threw,
the exception propagated out of the healing loop, and the run crashed. The healing
loop — the safety net for bad model output — had a latent crash bug on the most
common kind of bad model output.

## Tolerant Patch Application

The fix is to collect failures rather than throw on them. `preparePatches` now
returns two arrays: `appliedPatches` and `failedPatches`. A failed patch carries a
`closestRegion` — the result of a sliding-window scorer that walks the file and
finds where the search text *almost* matched. If the model's search block is stale
by three lines, the scorer returns lines 12-18 of the actual file so the model
has something concrete to correct against.

Security violations still throw immediately. Path traversal and symlink writes are
not match failures — they are boundary violations, and tolerating them would
undermine the entire safe-write contract. Everything else becomes data.

`healing.mjs` wraps `prepareChanges` in try/catch. A patch error during a repair
turn no longer crashes the loop; it feeds back into the next turn as structured
feedback.

## The Retry Loop

When patches fail, the model gets a structured correction prompt: which search
blocks didn't match, what the closest region in the file actually looks like, and
an instruction to re-emit corrected patches. Default is 2 retries. The loop runs
before the approval prompt, so the user sees a consolidated final write set rather
than a stream of partial attempts.

On a local model, tokens cost nothing except wall time, and a 600-second timeout
means there is room to spend turns on patch repair. The alternative — surfacing
raw patch failures to the user — produces worse outcomes: the user either
re-prompts with less context than the model would have gotten automatically, or
gives up.

## Three Edit Formats

Phase 102 ships three formats selectable via `--edit-format` or a model-profile
field:

- **`patch`** — the default, JSON search/replace, unchanged from before. The
  stable-section hash is byte-identical to the old hardcoded prompt text.
- **`whole`** — full-file rewrites. Useful when a file is small enough that a
  patch is more trouble than it's worth, or when the model is making changes
  across so many locations that search/replace blocks outnumber the unchanged
  lines.
- **`blocks`** — JSON-escaping-free SEARCH/REPLACE markers. The Aider lesson:
  weak models lose track of JSON escaping when the file content includes
  backslashes, quotes, or embedded strings. `blocks` format lets the model write
  raw code between markers.

Format is a model-profile field. A profile for a weak local model can declare
`editFormat: 'blocks'`; a profile for a capable model stays on `patch`. The Phase
100 eval suite can test both and report which format produces fewer patch failures
per model.

## The Blocks Format in Detail

The blocks parser accepts raw code between column-0 markers:

```
path/to/file.js
<<<<<<< SEARCH
old code here
=======
new code here
>>>>>>> REPLACE
```

Path is on the line above `<<<<<<< SEARCH`. The parser is strict about marker
column position — a marker indented by one space is not a marker — and tolerant
about everything else: fenced code block wrapping, CRLF line endings, backtick
path decoration. A model that wraps its output in a markdown fence still gets
parsed correctly. A model that puts a tab before a marker does not, which is the
right tradeoff: accidental code lines should not be misread as structural markers.

## Prompt-Prefix Stability

Parameterizing the base contract means each format has its own stable-section
hash. The hash changes when the format prompt changes, not when unrelated prompts
change, so the context-cache hit rate is maintained within a session. Switching
`--edit-format` between runs invalidates the cache, which is correct behavior:
the model contract changed.

## What This Enables

The immediate payoff is fewer run crashes on patch mismatch and a healing loop
that doesn't blow up on its own repair output. The longer payoff is measurement.
`kodr bench` in Phase 105 will run each model against each format and report
which combination produces the fewest failed patches, the fewest healing turns,
and the highest first-attempt success rate. The format field in model profiles
exists to hold the answer once it's known.
