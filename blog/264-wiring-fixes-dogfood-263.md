# Two Wiring Bugs That Cancelled Phases of Work

Phase 264 is a bug-fix phase triggered by the Phase 261–263 dogfood run. Both
bugs are wiring failures — the harness had the right logic, the right data, but
a broken connection between them.

---

## Bug 1: `suppressThinkingOnRunaway` was never forwarded

Phase 260 added runaway retry logic to the heal loop. When a reasoning model
spends too many tokens thinking before producing a response (`reasoning_runaway`
stop reason), the heal loop retries with thinking suppressed — a `/no_think`
prefix or `chat_template_kwargs` depending on what the model server honors.

The qwen3.6-35b-a3b profile declares `suppressThinkingOnRunaway: true`. The
heal loop checks `if (options.suppressThinkingOnRunaway === true)`. And that
check was always false.

The reason: two layers of code both had to carry the flag, and one of them didn't.

`normalizeProfile` builds a clean normalized object from the raw profile
definition. It carries `wireNoStream` explicitly:

```js
wireNoStream: profile.wireNoStream === true,
```

But it had no equivalent line for `suppressThinkingOnRunaway`. The field was
silently dropped every time a profile was normalized.

`applyModelProfileDefaults` had a forwarding block for `wireNoStream`:

```js
if (profile.wireNoStream) {
  next.wireNoStream = true;
  // ...
}
```

But no equivalent block for `suppressThinkingOnRunaway`. Even if
`normalizeProfile` had kept the flag, it would have been dropped here too.

The fix adds both missing pieces. `normalizeProfile` now carries it with a
conditional spread (matching the `toolAliases` pattern for optional fields):

```js
...(profile.suppressThinkingOnRunaway === true
  ? { suppressThinkingOnRunaway: true }
  : {}),
```

And `applyModelProfileDefaults` forwards it:

```js
if (profile.suppressThinkingOnRunaway) {
  next.suppressThinkingOnRunaway = true;
}
```

Phase 260 shipped its feature. The retry branch existed. The profile declared
the flag. But between profile loading and the heal loop, the data was dropped at
two points. The feature never fired.

---

## Bug 2: `detectNodeEsm` was blind to `node:` module references

The Node/ESM detection logic fires on:
- Any `.mjs` file in the workspace
- `.mjs` or `.cjs` named in the task prompt
- A `package.json` with `"type": "module"`

Phase 261 added a DatabaseSync anchor to the lang:node preamble. Phase 258 wired
multi-skill auto-injection so `lang:sqlite` fires alongside `lang:node` when the
task prompt mentions SQLite. These improvements matter most on greenfield runs —
empty workspaces where the model starts from scratch.

But a greenfield task prompt like:

```
build a notes API using node:sqlite and node:http
```

fails every one of the existing detection checks. No `.mjs` in the workspace. No
`.mjs` or `.cjs` in the prompt. No `package.json` at all. The result: `detectNodeEsm`
returns `false`, no Node guidance loads, and the DatabaseSync anchor and all
Node pitfalls are dark for exactly the run that most needs them.

The fix extends `detectNodeEsm` with one more check:

```js
if (typeof taskPrompt === 'string' && /\bnode:[a-z]/u.test(taskPrompt)) {
  return true;
}
```

`node:` is a Node.js-only protocol. Fetch, browsers, and every other runtime use
bare module names. Any task prompt that explicitly names `node:sqlite`,
`node:http`, `node:test`, `node:fs`, or any other Node built-in is unambiguously
a Node task.

### SQLITE_TASK_PATTERN greenfield fallback

There is a related case: a task prompt that says "build a notes API using
DatabaseSync" — no `node:` prefix, but `DatabaseSync` alone is a Node-only
identifier. `SQLITE_TASK_PATTERN` already matches it for gating the lang:sqlite
skill. But without `isNodeEsm = true`, the primary language is `null` and neither
skill fires.

For a **truly empty workspace** (no files), `SQLITE_TASK_PATTERN` matching is
treated as a Node greenfield signal:

```js
const sqliteMatch =
  !isNodeEsm &&
  !isRust &&
  !options.suppressLanguageGuidance &&
  files.length === 0 &&
  SQLITE_TASK_PATTERN.test(options.taskPrompt || '');
```

This is scoped to empty workspaces intentionally. A Python workspace with a
sqlite task prompt should not be mis-labelled as Node — an existing `main.py`
means something. The restriction `files.length === 0` ensures we only apply the
fallback on clean-slate greenfield runs.

---

## What these bugs have in common

Both bugs are wiring failures in code paths that were added incrementally:

- The heal-loop runaway retry (Phase 260) depended on a profile flag that was
  dropped during normalization — a silent null that only became observable
  on an actual runaway event.

- The Node detection extension (Phase 261 DatabaseSync anchor) depended on
  `isNodeEsm = true` to load its preamble, but the detection logic wasn't
  extended to cover the prompts that most need it.

Both fixes are small. Both were invisible without dogfooding runs that hit the
specific conditions. The Phase 261–263 dogfood run exposed both.
