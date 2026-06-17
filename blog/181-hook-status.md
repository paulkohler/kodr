# Phase 181: `kodr hook status`

Install and uninstall are useful, but "what's the current state?" is a question
that comes up at least as often. Instead of inspecting `.git/hooks/pre-commit`
by hand:

```
$ kodr hook status
pre-commit hook: installed by kodr
  path: /path/to/.git/hooks/pre-commit
  runs: kodr check --changed --strict
```

Three outcomes: `none` (no hook file), `kodr` (kodr installed it), or `foreign`
(someone else's hook, with a reminder that `--force` is needed to replace it).

The result object carries `hookStatus` so scripts can branch on the value without
parsing the text output.
