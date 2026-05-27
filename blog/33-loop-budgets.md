# Phase 33: Loop Budgets

Phase 33 makes long model loops more explicit. Local models can spend minutes processing a prompt, and continuation runs can quietly become several requests when the first response stops for length. Kodr now tracks loop turns, continuation retries, reported tokens, reported cost, and a final stop reason.

`kodr run` exposes `--max-turns`, `--max-retries`, `--max-tokens`, and `--max-cost-usd`. The first two are always meaningful because Kodr controls model calls and continuation retries. Token and cost budgets depend on OpenAI-compatible `usage` fields, so they are enforced when the local server reports them.

Continuous cycles now use the same budget primitive. A normal cycle run records `max_turns`; an explicit stop marker records `stop_marker`; and per-cycle usage can roll into the shared budget state.

This phase also ties the CLI version to the roadmap phase number. `kodr --version` now reports the highest phase number as `0.0.N`, and `npm run cversion` checks that `package.json` stays aligned.
