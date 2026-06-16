# Phase 163: `kodr check`

The three deterministic gates — syntax, smoke-check, cross-reference sensors —
run inside `kodr run` as a pipeline step. Phase 163 makes them available
standalone as `kodr check`.

```
$ kodr check
kodr check
  workspace: /path/to/project

✔ syntax check  14 files ok
✔ smoke check   src/index.mjs loaded ok (43ms)
– sensors       – no compose/HTML/CSS files

check passed
```

Implementation is clean: `runCheck` in `src/commands/check.mjs` recursively
walks the workspace (skipping `.git`, `node_modules`, `dist`, `build`, `.next`,
`.nuxt`, `.kodr`, `.cache`), builds a synthetic `writeResult` covering all
files, and passes it to the same gate functions the pipeline already uses. No
duplicate gate logic.

Exit codes match the pipeline:
- `0` — syntax ok (warnings from smoke/sensors don't fail `kodr check`)
- `1` — syntax error

`--no-smoke` and `--no-sensors` suppress the respective gates.

What `kodr check` is for: drop it at the top of a CI job or run it after a
hand-edit to sanity-check the workspace before committing. It's the same signal
that `kodr run` would see, but without a model in the loop.
