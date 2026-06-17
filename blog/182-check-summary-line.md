# Phase 182: `kodr check` TTY Summary Line

After running all gates, `kodr check` now prints a dimmed summary before the
final pass/fail line:

```
✔ syntax check  1 file ok
✔ compose-dockerfile  1 compose file ok
1 file · 1 sensor

check passed
```

Or with warnings:

```
⚠ compose-dockerfile  no Dockerfile at .
1 file · 1 sensor · 1 warning

check passed
```

The segments are omitted when their count is zero, so a plain syntax-only check
shows just `2 files`. The line is dimmed to stay out of the way — it's context,
not signal.

`--json` output is unchanged.
