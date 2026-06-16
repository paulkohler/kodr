# js-extract-module

Cross-file refactor fixture: extract a shared utility from duplicated code.

## Starting state

`src/string-ops.mjs` has two functions (`formatName`, `formatTitle`) that both
implement the same title-casing logic — copy-paste duplication.

`test/string-ops.test.mjs` imports `toTitleCase` from `src/utils.mjs`, which
does not exist yet. The tests fail because the import cannot be resolved.

## Expected outcome

The model must:
1. Create `src/utils.mjs` exporting `toTitleCase(s)`.
2. Update `src/string-ops.mjs` to import and delegate to `toTitleCase`
   (both `formatName` and `formatTitle` should use it).

This tests cross-file import/export coordination: a new file must be created
AND the existing file must be updated with a consistent import path.

## Baseline

```
node --test
```

fails because `src/utils.mjs` does not exist.
