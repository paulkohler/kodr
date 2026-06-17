# Phase 194: Bridge `kodr check` Findings Into a Fix Run

`kodr check` has been purely diagnostic since it landed — it tells you what is
wrong, but leaves the translation to a prompt entirely up to you. Phase 194
closes that gap.

## Usage

```sh
kodr check --fix
```

When `--fix` is set and the check finds issues, it synthesises a targeted repair
prompt and feeds it directly to the local model — no copying, no prompt crafting,
no second command. The model sees something like:

```
Fix the following issues found by `kodr check` in this workspace.
Address only the listed issues. Do not refactor or change unrelated code.

1. local-import in src/app.mjs: unresolved import './missing-helper.mjs'
2. import-cycles: import cycle: src/a.mjs → src/b.mjs → src/a.mjs
```

The fix run applies writes just like a regular `kodr run`. Dry-run mode still
works — pass `--dry-run` alongside `--fix` to see what the model would change
without applying it.

When the check is clean, `--fix` does nothing extra — no model call, no cost.

## Implementation

`buildFixPrompt(checkResult)` in `check.mjs` maps structured check output to
numbered items:

- **Syntax failures** → `syntax error in <file>: <message>`
- **Sensor warns** → `<sensor> in <loc>: <detail>` (import path, build context,
  cycle chain, or secret match, depending on the sensor)

`runCheck` returns `{ fixPrompt }` when issues are found. The dispatch in
`app.mjs` intercepts it:

```js
const checkResult = await runCheck(options, checkIo);
if (checkResult.fixPrompt) {
  const fixOptions = { ...options, command: 'run', prompt: checkResult.fixPrompt, yes: true };
  return runPrompt(fixOptions, checkIo);
}
return checkResult;
```

The `yes: true` in `fixOptions` means writes are auto-applied, mirroring how
`kodr run` behaves by default.

## Kodr integration test

`~/src/kodr-testing/phase-194/check-fix-test/`:

- A project with a deliberately broken import (`import { x } from './missing.mjs'`)
- `kodr check --fix` fires the local model with the sensor findings
- The model adds or corrects the export; `kodr check` passes clean afterward

## Narrowness of the repair prompt

The wording "address only the listed issues, do not refactor or change unrelated
code" is load-bearing. Without it, models tend to expand scope — rewriting the
whole file to "fix" an import. The numbered list anchors the model to specific
issues, which tends to produce smaller, safer patches.
