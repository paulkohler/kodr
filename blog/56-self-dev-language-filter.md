# Phase 56: Self-Dev — Language Filter on Inspect

_Kodr editing Kodr. Third self-development trial._

The task: add a `--languages` flag to `kodr inspect` that threads through two
files — `src/app.mjs` (flag parsing and dispatch) and `src/code-inspector.mjs`
(the actual filter). Five patches, no new files.

---

## Harness improvements landing before this run

Two gaps found in phase 55 were fixed first:

**Pre-flight test command validation.** `runPrompt` now calls
`parseVerificationCommand` at the very top — before the model call, before any
writes — so a bad `--test` argument is caught immediately. Phase 55's failure
(writes on disk, invalid test command) cannot recur.

**Git-aware `--protect-existing`.** The check now runs `git ls-files
--error-unmatch` instead of testing file existence on disk. Untracked leftover
files from previous failed runs no longer block new runs that intend to create
those paths.

---

## The run

All five patches applied on the first attempt. Tests ran. One failure.

**The failure: `--languages` registered in `assignValue` but not in the
dispatch list.**

`app.mjs` has two related code locations for each value-consuming flag:

1. The long `if (arg === '--base-url' || arg === '--model' || ...)` chain that
   marks a flag as consuming the next token.
2. The `assignValue` switch that routes the value to the right option field.

The model correctly added `--languages` to `assignValue` (location 2) but
missed location 1. The parser saw `--languages` as an unknown boolean flag and
threw `CliError: Unknown option: --languages`.

One-line fix: add `arg === '--languages'` to the dispatch chain.

**Verdict:** The model got the multi-file threading right — it correctly patched
both `app.mjs` and `code-inspector.mjs` with the right logic. It missed one of
two coupled locations within a single file.

---

## What the model got right

All the substantive changes were correct:

- `inspectLanguages: []` default in options init
- `languages: options.inspectLanguages.length > 0 ? options.inspectLanguages : undefined` passed into `inspectWorkspace`
- Filter guard in `inspectWorkspace`: `if (options.languages && !options.languages.includes(language)) continue;`
- `assignValue` case for `--languages`
- New test: two-file workspace (`.go` + `.py`), filter to `go`, assert no python files

The `countLanguages` call at the end naturally reflects only the kept files —
no extra patch needed there.

---

## The two-location pattern

Flag parsing in `app.mjs` has a structural split: one location marks a flag as
value-consuming, another assigns the value. When adding a new value flag,
**both** locations must be updated. The model reliably finds and patches one;
it needs the prompt to name both explicitly.

For future self-dev prompts: when adding a flag to `app.mjs`, include a note
like — _"This flag takes a value; add it to both the dispatch list (around line
204) and the `assignValue` switch (around line 970)."_

---

## Cumulative self-dev scorecard

| Phase | Task | Model patches | Manual fixes | Root cause |
|-------|------|---------------|--------------|------------|
| 54 | Add fields to `inspectWorkspace` | 1 correct (code-inspector) | 2 (test patch search wrong, test file manually edited) | No file content in context; hallucinated whole file |
| 55 | `kodr registry` command | 3 correct + test file | 0 (after allowlist fix + clean state) | Allowlist gap; stale leftover file |
| 56 | `--languages` filter | 5 correct logic | 1 (missed dispatch list entry) | Two-location pattern not named in prompt |

The model is improving — or rather, the prompts and harness are improving. Phase
56 had zero context failures, zero hallucinations, and correct multi-file
reasoning. The remaining gap is knowing which locations in a complex file need
to be kept in sync.

---

## What works well now

- `--inspect-context` reliably puts the right function bodies in context
- Exact search strings in prompts eliminate all indentation/variant guessing
- `--protect-existing` (git-aware) correctly distinguishes new files from tracked ones
- Pre-flight test validation catches bad `--test` args before any writes land
