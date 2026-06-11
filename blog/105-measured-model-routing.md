# Phase 105 — Measured Model Routing

The previous routing story was "set `--model` and hope for the best." Phase 105
replaces the hope with measurements.

## The problem

Kodr runs on whatever model LM Studio happens to be serving. A large reasoning
model is great for edits but overkill for generating a one-line commit message.
A small fast model might pass the commit-message bar and nothing else. Manually
juggling two model flags defeats the purpose of having a tool.

The answer: run the eval suite against every available model, store the scores,
and derive a routing table from the results.

## `kodr bench`

```
kodr bench --suite evals/suite.json
```

The command:
1. Calls `GET /v1/models` on the configured base URL to discover every model
   LM Studio is serving.
2. Runs the full eval suite against each model using `runWorkspaceSuite` (the
   same runner as `kodr eval`).
3. Writes per-model scores to `.kodr/bench-scores.json`.
4. Derives a routing table and writes it to `.kodr/routing.json`.
5. Prints a formatted summary.

```
Bench: brownfield-edits
Models: qwen/qwen3.6-35b-a3b, qwen2.5-coder-3b

Running suite against: qwen/qwen3.6-35b-a3b
  qwen/qwen3.6-35b-a3b: 8/10 (score 0.80)

Running suite against: qwen2.5-coder-3b
  qwen2.5-coder-3b: 4/10 (score 0.40)

Bench results:
  qwen/qwen3.6-35b-a3b: 0.80 (8/10) (2026-06-11)
  qwen2.5-coder-3b: 0.40 (4/10) (2026-06-11)

Routing:
  edit  → qwen/qwen3.6-35b-a3b (score 0.80)
  cheap → qwen2.5-coder-3b (score 0.40)
```

## `computeRoutingTable`

The logic is intentionally simple:

- **editModel**: highest-scoring model. Used for file edits and planning.
- **cheapModel**: highest-scoring model *other than* the edit model that
  exceeds a threshold (default 0.3). Falls back to the edit model when no
  second model qualifies or only one model exists.

No ML, no fancy heuristics. Scores are stable across runs on the same hardware
and model set, so the table only needs regenerating when the model roster
changes.

## Routing table is advisory

The table is loaded by `applyModelProfileDefaults` and stored in
`options.routingTable`, but it never auto-overrides `options.model`. The user's
explicit `--model` flag always wins. A future `/model auto` TUI command can
activate the routing table interactively.

## The async change

`applyModelProfileDefaults` had to become `async` to load the routing table
from disk without blocking. Every call site in `app.mjs` gained an `await`;
the agent-model map resolved with `Promise.all`. The change is mechanical and
the existing test suite confirms behaviour is unchanged.

## Failures

None. The design was conservative by choice — advisory routing rather than
auto-switching kept the blast radius small.
