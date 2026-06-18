# Phase 209: Auto-disable Inspection Context for Thinking Models

## The problem

Every thinking-model run required an explicit `--no-inspect-context` flag.
Without it, qwen3.6 would loop during inspection on `--continue` sessions where
stale files from `.kodr/backups/` showed up in the file index alongside the
current source. Phase 206 fixed the root cause (exclude `.kodr` from the
index), but the flag remained a manual requirement — a footgun for anyone
running thinking models without knowing the history.

## The signal was already there

Phase 205 added `wireNoStream: true` to thinking-model profiles as the
canonical indicator that a model needs non-streaming wire transport. The same
property already flowed through `applyModelProfileDefaults` to set
`options.wireNoStream`. Inspection context was simply missing from that branch.

## The fix

One conditional in `applyModelProfileDefaults`:

```js
if (profile.wireNoStream) {
    next.wireNoStream = true;
    if (!options._inspectContextSet) {
        next.inspectContext = false;
    }
}
```

`_inspectContextSet` is `true` when the user passes `--inspect-context` or
`--no-inspect-context` explicitly. So:

| Run | `_inspectContextSet` | Result |
|-----|----------------------|--------|
| `kodr run` on qwen3.6 | false | `inspectContext = false` (auto) |
| `kodr run --inspect-context` on qwen3.6 | true | `inspectContext = true` (user override) |
| `kodr run --no-inspect-context` on qwen3.6 | true | `inspectContext = false` (explicit, same as auto) |
| `kodr run` on devstral (non-thinking) | false | `inspectContext = 'auto'` (unchanged) |

## What this changes for users

Thinking-model runs no longer need `--no-inspect-context`. The pattern:

```sh
kodr run --yes --no-heal --no-tools --no-inspect-context --no-protect-existing \
  --test "node --test" --max-turns 20 -p "..."
```

becomes:

```sh
kodr run --yes --no-heal --no-tools --no-protect-existing \
  --test "node --test" --max-turns 20 -p "..."
```

`--inspect-context` remains the escape hatch for fresh workspaces where it's
safe, or for users who want to compare the difference.

## Tests

Four new cases in `test/model-profiles.test.mjs`:
1. Thinking model without CLI flag → `inspectContext` is `false`
2. Thinking model with `--inspect-context` → stays `true`
3. Thinking model with `--no-inspect-context` → stays `false`
4. Non-thinking model → `inspectContext` unchanged (`'auto'`)

32/32 pass.
