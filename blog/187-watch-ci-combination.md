# Phase 187: `kodr check --watch --ci`

Two flags that were always meant to go together.

`--ci` is `--changed --strict`: scan only modified files, fail on any warning.
`--watch` re-runs on every change. Combined:

```sh
kodr check --watch --ci
```

You get a live CI gate that re-fires whenever you save. When it fails, the
terminal shows the warning. Fix the file, save, and it re-runs automatically.

The watcher stays alive through failures — that's intentional. A failed check
doesn't kill the loop; it waits for you to fix things and try again.

The combination already worked (both flags compose at the parser level), but it
was never tested. Four new tests verify the initial run, the summary line, and
the keep-alive-through-failure behaviour.
