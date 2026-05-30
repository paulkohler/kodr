# Phase 56: Self-Dev — Language Filter on Inspect

## Goal

Add a `--languages` flag to `kodr inspect` that restricts the index to the
named languages only.

This is the third self-development test. It requires the model to thread a new
flag through `src/app.mjs` into `src/code-inspector.mjs`.

## Behaviour

```
kodr inspect --languages go,python [--symbol name] [--json]
```

`--languages` accepts a comma-separated list. Files whose `classifyLanguage`
result is not in the list are excluded from `files`, `languages`, and `symbols`
in the returned index. `references` is filtered by the same file set.

If `--languages` is omitted the behaviour is unchanged.

## Done Criteria

- [ ] `--languages` flag parsed in `src/app.mjs` and passed as `options.languages`
      (string array) to `inspectWorkspace`.
- [ ] `inspectWorkspace` in `src/code-inspector.mjs` filters files by language
      when `options.languages` is provided.
- [ ] `languages` count map in the index reflects only the kept languages.
- [ ] Existing tests still pass.
- [ ] New test covering `--languages` filtering added to
      `test/inspect-command.test.mjs` or `test/code-inspector.test.mjs`.
- [ ] `npm run format` and `npm run check` pass.
- [ ] Decisions recorded.
- [ ] Roadmap marked complete and committed.

## Self-Dev Notes

Threading a flag through two files is the main challenge here. If the model
only edits one file and forgets the other, that is a multi-file reasoning gap
to diagnose. Try `--inspect-context` on retry to see if both files appear in
the packed context.
