# Phase 200: Include fixPrompt in kodr check --json Output

`kodr check --json` now includes a `fixPrompt` field when there are sensor or
syntax issues. This closes the loop on the `--fix` pipeline and makes the
structured output genuinely actionable.

## What changed

```sh
# Before: you'd get sensor issues in JSON but had to construct the prompt yourself
kodr check --json | jq '.sensors[].issues'

# After: the repair prompt is included directly
kodr check --json | jq -r '.fixPrompt // empty'
```

Example output for a workspace with an unresolved import:

```json
{
  "ok": true,
  "command": "check",
  "sensors": [...],
  "fixPrompt": "Fix the following issues found by `kodr check` in this workspace.\nAddress only the listed issues. Do not refactor or change unrelated code.\n\n1. local-import in src/app.mjs: unresolved import './missing.mjs'"
}
```

When the check is clean, `fixPrompt` is absent — a consuming script can use
`.fixPrompt // empty` to safely detect the no-issues case.

## Pipe pattern

```sh
# Run check, extract fix prompt, pipe to model
kodr check --json \
  | jq -r '.fixPrompt // empty' \
  | grep -q . \
  && kodr run --prompt-file /dev/stdin

# Or more concisely with kodr run once the prompt is confirmed
PROMPT=$(kodr check --json | jq -r '.fixPrompt // empty')
[ -n "$PROMPT" ] && echo "$PROMPT" | kodr run --prompt-file /dev/stdin
```

## Implementation

`buildFixPrompt(checkResult)` was already available in `check.mjs`. The JSON path
now calls it before stringifying and includes the result as `jsonOut.fixPrompt`
when non-null. This reuses the same formatting logic as `--fix`, so the prompt
in JSON is identical to what `--fix` would send to the model.
