# Phase 184: Smoke-Check Heal Integration

## The gap

The smoke-check (phase 156) catches import-time crashes that `node --check` misses.
But when smoke failed, the run ended with `ok: false` and no repair. The heal loop
never saw the smoke failure because it ran before the smoke-check.

## The fix

### `smokeResultToVerification`

A new adapter converts a definitive smoke failure into the verification-result
shape the heal loop expects:

```js
const verif = smokeResultToVerification({ status: 'failed', entry: 'index.mjs',
  message: 'TypeError: Cannot read properties of undefined' });
// → { ok: false, exitCode: 1, stderr: 'TypeError: ...', command: 'node ... smoke: index.mjs' }
```

### Second heal pass

When smoke fails definitively and a test command is configured, the pipeline now
runs a second `runHealingIfNeeded` driven by the smoke failure, then re-runs the
smoke-check:

```
initial heal (test failures) → smoke-check → smoke-heal (if failed) → re-smoke
```

### Known limitation

The in-loop verification for the smoke-driven heal still uses `options.testCommand`
(not the smoke-check itself). If no `testCommand` is set, no smoke-driven heal
runs. Full smoke-as-verification would require architecture changes to the heal
loop to support pluggable verification backends.
