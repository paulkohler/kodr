# Phase 189: Gate-Skip Observability

`summary.json` used to leave you guessing. A missing `smokeCheck` field
could mean the gate was disabled, the write wasn't applied, or there was
no JS entry point. Three different stories, one (absent) field.

Now `summary.json` includes `gateSkips` whenever a gate didn't run due
to configuration or eligibility conditions:

```json
{
  "gateSkips": {
    "smoke": { "ran": false, "reason": "disabled" },
    "sensors": { "ran": false, "reason": "disabled" }
  }
}
```

Possible reasons:
- `"disabled"` — `--no-smoke` or `--no-sensors` was passed
- `"write-not-applied"` — run was dry, write never landed
- `"write-error"` — write failed, gates skipped
- `"sandbox-active"` — smoke-check skipped to avoid running untrusted code on host

`gateSkips` is absent on clean runs (zero overhead). `null` fields still
mean "ran but nothing to scan". This field is new and additive — existing
tooling is not affected.

`kodr check --no-smoke --json` now shows the skip reason directly.
