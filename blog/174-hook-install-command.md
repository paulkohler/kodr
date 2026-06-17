# Phase 174: `kodr hook install` — Pre-commit Hook Installer

The previous phases built `kodr check --changed --strict`: a fast, git-aware check
that promotes sensor warnings to failures. Phase 174 makes it trivial to put that
gate on every commit.

## Usage

```
kodr hook install           # write .git/hooks/pre-commit
kodr hook install --force   # overwrite any existing hook
```

After installation, every `git commit` runs:

```sh
kodr check --changed --strict
```

If any sensor warns or a syntax error is found in the changed files, the commit
is blocked.

## Implementation

`resolveHooksDir` uses `git rev-parse --git-dir` to locate the `.git` directory.
This handles git worktrees and repos nested inside other repos — the git dir is
wherever git says it is, not assumed to be `cwd/.git`.

The hook is guarded: if a `pre-commit` file already exists and wasn't installed
by kodr (identified by a comment header), the command refuses to overwrite it
without `--force`. This protects hand-written hooks from being silently replaced.

The hook file is written with `chmod 0o755` immediately after creation, so it's
executable from the first install without a separate manual step.

## Removing the hook

Uninstall is just `rm .git/hooks/pre-commit`. There's no `kodr hook uninstall`
command — shell idioms are simpler here.
