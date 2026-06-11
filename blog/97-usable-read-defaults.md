# Phase 97: Usable Read Defaults

Kodr's four most impactful run-time flags — `--tools`, `--stream`, `--heal`,
and `--inspect-context` — used to default to `false`. That was safe, but it
meant most useful behaviors required explicit flags on every invocation. Phase 97
converts all four to **tri-state `'auto'`** defaults that wire up the right
behavior without user input, while remaining fully overridable.

## The Tri-State Pattern

Each flag now follows the same `'auto' | true | false` pattern already used by
`--staged`:

| Flag | `auto` resolution |
|------|-------------------|
| `--tools` | `true` when model profile has `nativeToolCalls: true` |
| `--stream` | `true` when `io.stdout.isTTY === true && !--json` |
| `--heal` | `true` when both `--yes` and `--test` are set |
| `--inspect-context` | `true`, falls back gracefully on index errors |

The project config and `--no-*` flags (`--no-tools`, `--no-stream`, `--no-heal`,
`--no-inspect-context`) can force any of these off. Flag > env > config > profile
> builtin precedence is preserved.

## Tools Auto-Resolution

`tools: 'auto'` resolves in `applyModelProfileDefaults()` by reading
`profile.nativeToolCalls`. For qwen and most local models the field is `true`,
so tools are on by default. A profile with `nativeToolCalls: false` opts out
automatically.

`configSources.tools` becomes `'profile'` when auto-resolution fires, so
`--show-config` makes the origin visible.

## Stream Auto-Resolution

Stream resolves immediately after `parseArgs` in `main()`, because `io` is not
available inside the parser. For interactive TTY runs the model sees `stream:
true` and `onStreamContent` writes chunks directly to stdout as they arrive.
For `--json`, non-TTY, or server-turn calls, stream stays off.

## Heal Auto-Resolution

Heal resolution stays lazy: `runHealingIfNeeded` checks at runtime whether
`options.heal !== false` and whether `--yes` and `--test` were supplied and a
test ran. The common pattern of `kodr run --yes --test "npm test"` now
automatically heals on failure without a third flag.

`--no-heal` opts out if you want to observe the failure without a repair turn.

## Inspection-Aware Context Packing

`inspectContext: 'auto'` runs the inspection index on every `run` call. When
the index builds cleanly, the prompt gets an inspection-aware plan. When it
fails (empty workspace, missing registry), the run falls back to whole-file
packing gracefully — no error, just a different strategy.

The `hasInspectionTargets` guard prevents empty plans (all `(none)` entries on
bare temp dirs) from being prepended to prompts. This was the sharpest edge
during implementation: auto-mode ran inspection on test temp dirs and produced
all-empty plans that broke dozens of tests before the guard was added.

## Context Packing Strategy in summary.json

Every run now records which context packing strategy was used:

```json
"contextPacking": {
  "strategy": "inspection-aware",
  "fallbackReason": null
}
```

Possible strategies: `inspection-aware`, `whole-file`, `file-map` (tools-on
path). `fallbackReason` captures the error message when inspection fell back.

## Failures

**Auto-heal tests used shell scripts in temp dirs**: `parseVerificationCommand`
allowlists only `npm test`, `npm run test`, `node --test`, and
`node --check <file>`. Shell scripts in `/tmp` are never allowed. Rewrote the
heal integration tests to use `node --check bad.mjs` with a broken-then-fixed
file from the fake model, matching the existing heal test pattern.

**tools: auto resolving to true broke 4 existing tests**: The qwen default
profile has `nativeToolCalls: true`, so `tools: 'auto'` resolves to `true` and
switches those tests from the continuations code path to the tool-calls path.
Fixed by adding `--no-tools` to the 4 tests that specifically exercise
non-tools behaviors (length-continuation, response_format, etc.).
