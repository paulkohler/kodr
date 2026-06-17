# Phase 185: `kodr check --ci`

`kodr check --changed --strict` is the natural CI gate — scope to modified files,
fail on any warning. Two flags, but it was always one idea.

Now:

```sh
kodr check --ci          # equivalent to --changed --strict
kodr check --ci --deep   # add transitive cycle detection
```

The pre-commit hook installed by `kodr hook install` already uses
`--changed --strict`. You can update it to `--ci` (functionally identical, clearer
intent) or just leave it as is — both work.
