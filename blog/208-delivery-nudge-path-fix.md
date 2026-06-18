# Phase 208: deliveryNudge False-Positive Path Extraction Fix

The deliveryNudge is a guard that fires a second model turn when the prompt
explicitly names files the model didn't deliver. It's been useful — catching
the case where a model produces a correct response but omits one file from
the proposal. Phase-209 dogfooding, however, surfaced a systematic bug: the
nudge was creating phantom files on every file-upload run.

## The three false positives

Three paths appeared in the deliveryNudge's "missing files" list when they had
no business being there:

- **`test.txt`** — extracted from `filename="test.txt"` in a multipart body
  helper that the prompt included as a code example
- **`files/test.txt`** — extracted from `fs.writeFileSync('files/test.txt',
  data)` inside the same code block
- **`store.mjs`** — extracted from a description like "The `store.mjs` module
  handles state" mid-sentence in the prompt prose

All three were fed to the nudge as "missing", the model dutifully wrote them,
and they appeared in the workspace. Tests still passed — the file contents were
benign — but phantom files are a correctness problem and a CI noise source.

## Root cause

`extractPromptFilePaths` scanned the entire raw prompt string with a regex:

```js
const pathRe = /(?<!\w)[a-z][\w./-]*\.[a-z]{1,6}/g;
```

No distinction between:
- Prose/manifest text ("here are the files to create")
- Code blocks showing examples ("multipart helper", "fs.writeFile usage")
- Mid-sentence module references ("import from store.mjs")

All three look identical to the regex.

## The fix (two rules)

**Rule 1 — strip fenced code blocks first.** Paths in code examples are
illustration, not delivery requirements. A two-line regex handles it:

```js
const stripped = promptText.replace(/`{3}[\s\S]*?`{3}/g, '');
```

This eliminates `test.txt` and `files/test.txt` in a single pass.

**Rule 2 — bare names (no `/`) must start the line.** File manifests in kodr
prompts look like this:

```
src/db.mjs — initialises the links table
src/server.mjs — Express app
package.json — {"type":"module"}
```

Or with bullets:

```
- store.mjs: exports Store
- index.mjs: entry point
```

In both cases the path is at the start of the line. A mid-sentence reference
like "the `store.mjs` module" is never at line start. So:

```js
const lineStart = stripped.lastIndexOf('\n', m.index);
const beforeOnLine = stripped.slice(lineStart + 1, m.index);
if (/^[ \t]*(?:-[ \t]*)?$/.test(beforeOnLine)) {
    found.add(p);
}
```

`store.mjs` mid-sentence: rejected. `store.mjs` starting a line: accepted.

Paths that contain `/` (like `src/store.mjs`) are accepted regardless of
position — a `/` already makes the path unambiguous.

## Results

Eight tests pass, including four new ones covering:
1. Paths inside fenced code blocks are ignored
2. Bare names mid-sentence are ignored
3. Bare names at line start ARE extracted
4. Bare names after a bullet at line start ARE extracted

The original three false positives are all eliminated. No regressions.
