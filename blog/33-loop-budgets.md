# Phase 33: Loop Budgets

Phase 33 makes long model loops explicit. The trigger was practical: local model runs can sit on `processing prompt` for a long time, and larger context-window settings can push the machine into heavy memory pressure before the harness has any useful signal to show. A timeout catches one request, but it does not describe the whole loop.

Kodr now tracks loop turns, continuation retries, reported tokens, reported cost, and a final stop reason. The point is not precise billing for local models. The point is to make the control plane visible: how many model calls happened, why the loop continued, and what condition eventually stopped it.

`kodr run` exposes `--max-turns`, `--max-retries`, `--max-tokens`, and `--max-cost-usd`. The first two are always meaningful because Kodr controls model calls and continuation retries. Token and cost budgets depend on OpenAI-compatible `usage` fields, so they are enforced when the local server reports them.

Continuation runs are the first beneficiary. Before this phase, the continuation limit was a hard-coded loop count. Now the limit is named, configurable, tested, and recorded in artifacts. If a model keeps returning `finish_reason: "length"`, Kodr records a budget stop instead of hiding the policy inside the implementation.

Continuous cycles now use the same budget primitive. A normal cycle run records `max_turns`; an explicit stop marker records `stop_marker`; and per-cycle usage can roll into the shared budget state. That gives future agent loops one vocabulary for "we stopped because we were done" versus "we stopped because the loop budget was spent."

This phase also ties the CLI version to the roadmap phase number. `kodr --version` now reports the highest phase number as `0.0.N`, and `npm run cversion` checks that `package.json` stays aligned.

The main lesson is that loop control is not just a safety feature. It is part of the debugging surface. When examples fail or local calls run hot, the harness should preserve enough state to decide whether the app prompt was too large, the model stalled, the context budget was wrong, or the agent loop itself needs a different shape.
