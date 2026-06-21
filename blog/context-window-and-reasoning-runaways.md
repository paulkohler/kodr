# Context Window Size and Reasoning Runaways

A short experiment with the qwen3.6-35b-a3b profile taught us something concrete
about how context window size affects thinking models in practice.

## The symptom

The phase-245 dogfood ran a staged REST API task at 32k context. The implement
stage completed normally — the model wrote files, finished with `finish_reason=stop`
— but then the heal loop triggered. On the third repair turn the run died:

```
completionTokens: 4096 / 4096
content chars: 0
finish_reason: length
```

24,961 completion tokens burned on the initial turn, then 8,192 more on the capped
retry. Nothing came out. The proximity guard (phase 244) correctly classified both
as genuine runaways — 100% of cap, zero text — but no amount of retrying could
fix the root cause: the model had nowhere to put its answer.

## Why this happens with thinking models

Qwen3.6-35b-a3b uses extended thinking. When it reasons, it emits tokens into a
hidden thinking stream before producing any visible output. The `max_tokens` value
covers the total budget — thinking tokens plus answer tokens. If thinking expands
to fill the full budget, there are zero tokens left for the actual response.

At 32k context (4096 `completionReserve`) the model routinely generated 20,000+
thinking tokens on a moderately complex repair prompt. That blew past the 4,096
cap, truncated mid-reasoning, and left the response empty. The model was not
confused or wrong — it just ran out of space before it could say anything.

The capped retry set `max_tokens: 8192` (the staged-retry floor). The model then
spent 8,192 tokens reasoning about the same problem. Still no answer.

## The fix: load the model at 262k context

After bumping LM Studio to 262,144 tokens for this model, we ran the identical
task. The numbers tell the story:

| Metric | 32k context | 262k context |
|--------|------------|--------------|
| Completion tokens (total) | 51,524 | 6,606 |
| Max thinking per turn | ~81,847 chars | ~6,120 chars |
| `finish_reason=length` hits | 2 (main + retry) | 0 |
| Runaway detected | Yes | No |
| Capped retry needed | Yes | No |

The model bounded its thinking at 262k. It did not reason for 80k chars when
6k was enough. The extra capacity did not lead to more verbose reasoning — it gave
the model room to conclude, which it took.

## Why reasoning models need headroom

The practical lesson: a thinking model at a tight context window is not the same
as a thinking model at a large context window. The difference is not just "handles
longer inputs" — it is that the model's internal budget for reasoning changes.

At 32k, the token ceiling is close enough to the typical reasoning depth that the
model frequently hits it before producing output. At 262k, the same model has
~258k tokens available and consistently stays well below that on tasks of moderate
complexity.

This is not a reasoning-runaway detection problem. The proximity guard fires
correctly in both cases (it correctly *did not* classify the capped-retry as a
runaway at 32k — that was a legitimate non-runaway truncation). The guard protects
against false positives, not against the model genuinely running out of space.

## Profile update

The qwen/qwen3.6-35b-a3b profile `contextWindow` was updated from 32768 to
262144. Kodr dynamically discovers the actual context window from LM Studio at
run time (phase 146), so this value is a fallback — but keeping the profile
accurate matters for the context budget calculator and for runs where LM Studio
is not available.

The `contextBudgetChars` ceiling rises from 80,000 to 320,000 chars at this window
size (the formula `min(320000, max(80000, contextWindow * 2))` caps out at 262k+).
This means the context packer can actually use the larger window for input context,
not just give the model more room to think.

## What 262k did not fix

The 262k run produced 11/14 passing tests (vs 8/9 at 32k). The 3 failures are
test design bugs in the generated test file, not API bugs:

1. **`GET /notes — returns empty array initially`** — placed *after* a `POST` that
   created a note. The shared `:memory:` DB already had one row.
2. **`GET /notes — returns list after creating notes`** — creates 2 notes and
   expects `length === 2`, but the DB already held a note from an earlier test.
   Gets 3 instead.
3. **`GET /search?q=term — returns matching notes`** — searches for "Test Note"
   which was deleted by an earlier DELETE test. Finds nothing.

The API implementation itself is correct: `DatabaseSync` import, `Number(lastInsertRowid)`,
`CURRENT_TIMESTAMP`, `row.columnName` access, FTS5 MATCH on the virtual table name,
and the `import.meta.url` listen guard all written correctly. The generated code
absorbed the lang:node pitfalls. The test file did not use `beforeEach` to reset
DB state between tests, leaving the tests order-dependent.

This is a gap in the lang:node skill: we teach the factory pattern and `:memory:`
for isolation, but not resetting table state between top-level `test()` blocks in
a shared DB. That is the next pitfall to add.
