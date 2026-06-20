# Phase 229 — Staged-Aware run_command / Turn-Exhaustion Guard Wording

## Goal

Make the three remaining `run_command` / turn-exhaustion guard wordings in `src/tool-calls.mjs` staged-aware, so that in a STAGED run (`options.inStagedPipeline === true`) they stop emitting envelope-only — and in one case factually false — instructions. Mirror the proven Phase-220 repeat-sentinel pattern (`const staged = options.inStagedPipeline === true;` + a staged/non-staged ternary). The non-staged wording at every site must stay **byte-identical** to today; only a staged branch is added.

## Why this is next

In a staged run the model writes files across stages using the `write_file` / `edit_file` TOOLS and completes a stage by returning `{"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]}`. It does **not** return a single final JSON envelope, and it **does** have write tools. Three guards still tell it otherwise:

- The turn-budget-exhausted final-turn message tells it to "Return the final JSON proposal now" — wrong instruction for a stage.
- The F1 allowlist-rejection hint says "The harness has no write tool" — **factually false** in staged mode, where `write_file` / `edit_file` are registered.
- The Phase-213 pending-write guard hint says "Return the final JSON proposal envelope now" — wrong instruction; in staged mode the model should keep writing files via tools.

Phase 220 already fixed the repeat-sentinel wording with exactly this branch and shipped the proven voice/format. This phase is the explicitly-tracked NEXT.md follow-up ("run_command pending-write guard: staged-mode wording") that closes out the remaining offending sites with the same pattern. It is small, fully unit-testable with no live model, and removes a class of misleading steering that the staged pipeline (qwen3.6) dogfooding keeps tripping over.

## Scope

**Exactly three sites (four code locations) in `src/tool-calls.mjs`:**

1. Turn-budget-exhausted final-turn message — line ~353 (request-building scope).
2. F1 allowlist-rejection hint — lines ~470 (dispatch `try`) and ~484 (the `catch` for a thrown `VerificationError`). Identical text; both updated identically.
3. Phase-213 pending-write guard hint — lines ~868–869 (the `run_command` handler closure inside `createBuiltinRegistry`).

**Out of scope (do NOT touch):**

- The repeat-sentinel at lines ~428–451 — already staged-aware as of Phase 220. Leave it exactly as-is; it is the reference, not a target.
- Any other guard, prompt, or surface. These three are precisely the `run_command` / turn guards that emit envelope-only (or false) wording reachable during a staged run. Extending further (other prompts, the E4 nudge, the S4 steer, system-prompt copy) would be scope creep without a verified staged-mode falsehood behind it.

## Changes

### Where `staged` comes from at each site (verify scope, do not assume)

- **Site 1 (line ~353):** in the request-building scope, **before** the tool-dispatch `for` loop. The only existing `const staged` is at line 428, **inside** that loop — it is NOT visible here. Declare a fresh `const staged = options.inStagedPipeline === true;` immediately before the `requestBody` / `isFinalTurn` message construction (e.g. just before the `const requestBody = applyResponseFormat(` block at ~346). `options` is the first function parameter of `completeWithToolCalls`, so it is in scope.
- **Sites 2 (lines ~470 and ~484):** inside the per-`toolCall` `for` loop, in the same scope as the repeat-sentinel's `const staged` at line 428. That `staged` is declared in the `if (seenToolCalls.has(callKey))` branch (line 428) but the F1 hints are in the sibling `else` branch (the `try`/`catch`), so the line-428 binding is NOT in scope in the `else`. Declare one `const staged = options.inStagedPipeline === true;` at the top of the `else { ... }` block (right after `seenToolCalls.set(callKey, 1);` at ~453, before the `try`) so both the `try` hint (~470) and the `catch` hint (~484) can read it. The implementer must confirm the `else`-block scope by reading lines 452–488 before placing the declaration.
- **Site 3 (lines ~868–869):** inside the `run_command` handler closure (`handler: async ({ command, timeoutMs }) => { ... }`) registered in `createBuiltinRegistry`. The closure already reads `options.commandRunner` and `options.toolWritesMode`, so `options` is in scope. Declare `const staged = options.inStagedPipeline === true;` inside the `if (...)` block right before constructing the returned `{ error, hint }` object (or at the top of the handler — implementer's call, but keep it close to use).

### DRY decision

The F1 hint string at sites 2 (lines ~470 and ~484) is **identical** today and will be identical after the change for both the staged and non-staged variants. AGENTS.md says to route shared surfaces through shared handling rather than duplicating. To avoid re-introducing the existing two-copy duplication, extract **one tiny module-scope helper** for the F1 hint and use it at both ~470 and ~484:

```js
// F1 allowlist-rejection steering hint. In staged mode the harness DOES have
// write_file/edit_file tools (Phase 229); in envelope mode it does not.
function allowlistWriteHint(staged) {
	return staged
		? 'Apply file changes via write_file/edit_file tool calls, not shell commands.'
		: 'The harness has no write tool. Return file changes in the final JSON proposal (files array), not via shell commands.';
}
```

Place it near the top of `tool-calls.mjs` (module scope, beside the other small helpers — implementer picks the spot, but module scope so it is callable from `completeWithToolCalls`). Do NOT extract helpers for sites 1 and 3: each of those strings appears exactly once, so inlining the ternary there is the minimal, clearest choice and a helper would add indirection without removing duplication. Keep the helper to this one F1 case.

---

### Site 1 — Turn-budget-exhausted final-turn message (~line 353)

**Current (byte-exact):**
```js
content:
	'Turn budget exhausted. Return the final JSON proposal now — do not call any tools.',
```

**Replacement** (add `const staged = ...` before the `requestBody` block, then branch the `content`):
```js
content: staged
	? 'Turn budget exhausted. Finish the current STAGE now — do not call any tools. ' +
		'Write any remaining file with write_file. ' +
		'If all files are already written, return {"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]} to complete this stage.'
	: 'Turn budget exhausted. Return the final JSON proposal now — do not call any tools.',
```

The non-staged string is byte-identical to today. (Note: the existing F1 final-turn test at line 1371 asserts the user message contains `budget` or `exhausted` case-insensitively — both branches begin with "Turn budget exhausted", so that test continues to pass unchanged.)

---

### Site 2 — F1 allowlist-rejection hint (~lines 470 and 484)

**Current (byte-exact, both occurrences):**
```js
hint: 'The harness has no write tool. Return file changes in the final JSON proposal (files array), not via shell commands.',
```

**Replacement** — at line ~470 (dispatch `try`):
```js
hint: allowlistWriteHint(staged),
```
and at line ~484 (the `catch` for the thrown `VerificationError`):
```js
hint: allowlistWriteHint(staged),
```
with the `allowlistWriteHint` helper (above) returning the byte-identical non-staged string when `staged` is false. The `error` field at both sites is unchanged (it carries the `Command is not allowlisted:`-prefixed message that the dispatch branch keys on).

---

### Site 3 — Phase-213 pending-write guard hint (~lines 868–869)

**Current (byte-exact):**
```js
return {
	error:
		'Files have not been applied to disk yet — run_command cannot access pending writes.',
	hint: 'Return the final JSON proposal envelope now. The harness will apply your writes and run verification automatically.',
};
```

**Replacement** (declare `const staged = options.inStagedPipeline === true;` in the handler before this, then branch ONLY the `hint`; keep `error` byte-identical because tests match `/pending writes/`):
```js
return {
	error:
		'Files have not been applied to disk yet — run_command cannot access pending writes.',
	hint: staged
		? 'Apply file changes via write_file tool calls. Do not run commands or tests until all files are written — verification runs automatically after all stages complete. ' +
			'If all files are already written, return {"status":"OK","files":[],"messages":[{"level":"info","content":"STAGED_DONE"}]} to complete this stage.'
		: 'Return the final JSON proposal envelope now. The harness will apply your writes and run verification automatically.',
};
```

The `error` string and the non-staged `hint` string are byte-identical to today.

## Tests

Add tests to `test/tool-calls.test.mjs`, mirroring the existing scaffolding. For sites 1 and 2 (which live inside `completeWithToolCalls`), reuse the **fake-model-server** pattern from the Phase-220 repeat-sentinel `describe` (lines ~3320–3562) and the F1 final-turn test (line ~1371): build `startFakeModelServer({ responses: [...] })`, call `completeWithToolCalls(options, ...)`, and inspect `completion.messages` / `server.recordings`. For site 3 (which lives in the `run_command` handler), reuse the **direct-dispatch** pattern from the Phase-213 `describe` (lines ~3101–3208): `createBuiltinRegistry(cwd, { commandRunner, inStagedPipeline })`, `await registry.dispatch('write_file', ...)` to seed the draft, then `await registry.dispatch('run_command', ...)` and assert on the returned object.

The implementer must first read the Phase-213 pending-write tests (~3101) and the Phase-220 repeat-sentinel tests (~3320) and copy their exact setup (registry/handler construction, fake server response shape).

### Site 1 — final-turn message (use the fake-model-server + `maxTurns: 1` pattern from the line-1371 test; inspect `server.recordings[0].requestBody.messages.at(-1)`)

`it('F1 final-turn message uses staged wording when inStagedPipeline is true', ...)`
- `options` includes `maxTurns: 1` and `inStagedPipeline: true`; fake server returns one `finish_reason: 'stop'` response.
- `const userMsg = server.recordings[0].requestBody.messages.at(-1);`
- `assert.equal(userMsg.role, 'user');`
- `assert.match(userMsg.content, /write_file/u);`
- `assert.match(userMsg.content, /STAGED_DONE/u);`
- `assert.ok(!userMsg.content.includes('final JSON proposal'), 'staged final-turn must not mention final JSON proposal');`
- `assert.match(userMsg.content, /Turn budget exhausted/u);` (shared prefix kept)

`it('F1 final-turn message keeps envelope wording when inStagedPipeline is absent', ...)`
- Same setup but `inStagedPipeline` omitted from `options`.
- `assert.match(userMsg.content, /Return the final JSON proposal now/u);`
- `assert.ok(!userMsg.content.includes('write_file'), 'envelope final-turn must not mention write_file');`
- `assert.ok(!userMsg.content.includes('STAGED_DONE'), 'envelope final-turn must not mention STAGED_DONE');`

### Site 2 — F1 allowlist-rejection hint (fake-model-server pattern: one `finish_reason: 'tool_calls'` response that calls `run_command` with a non-allowlisted command such as `{"command":"rm -rf /"}`, then a `finish_reason: 'stop'` final response; find the `role: 'tool'` message for that call in `completion.messages` and `JSON.parse(msg.content)`)

`it('F1 allowlist-rejection hint uses staged wording when inStagedPipeline is true', ...)`
- `options` includes `inStagedPipeline: true`.
- Parse the tool-result message for the `run_command` call.
- `assert.match(parsed.error, /Command is not allowlisted:/u);` (error prefix unchanged)
- `assert.match(parsed.hint, /write_file/u);`
- `assert.ok(!parsed.hint.includes('no write tool'), 'staged hint must not claim there is no write tool');`
- `assert.ok(!parsed.hint.includes('final JSON proposal'), 'staged hint must not mention final JSON proposal');`

`it('F1 allowlist-rejection hint keeps envelope wording when inStagedPipeline is absent', ...)`
- Same setup, `inStagedPipeline` omitted.
- `assert.match(parsed.error, /Command is not allowlisted:/u);`
- `assert.match(parsed.hint, /The harness has no write tool\./u);`
- `assert.match(parsed.hint, /final JSON proposal/u);`
- `assert.ok(!parsed.hint.includes('write_file'), 'envelope hint must not mention write_file');`

### Site 3 — Phase-213 pending-write guard hint (direct-dispatch pattern from line ~3102: seed the draft with `write_file`, then dispatch `run_command` referencing the pending path)

`it('pending-write guard hint uses staged wording when inStagedPipeline is true', ...)`
- `const registry = createBuiltinRegistry(cwd, { commandRunner: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }), inStagedPipeline: true });`
- Seed: `await registry.dispatch('write_file', '{"path":"test/foo.test.mjs","content":"// pending\\n"}');`
- `const result = await registry.dispatch('run_command', '{"command":"node --test test/foo.test.mjs"}');`
- `assert.match(result.error, /pending writes/u);` (error unchanged)
- `assert.match(result.hint, /write_file/u);`
- `assert.match(result.hint, /STAGED_DONE/u);`
- `assert.ok(!result.hint.includes('final JSON proposal'), 'staged hint must not mention final JSON proposal');`

`it('pending-write guard hint keeps envelope wording when inStagedPipeline is absent', ...)`
- Same setup, `inStagedPipeline` omitted (default `applyMode` is `'proposal'`).
- `assert.match(result.error, /pending writes/u);`
- `assert.match(result.hint, /Return the final JSON proposal envelope now\./u);`
- `assert.ok(!result.hint.includes('write_file'), 'envelope hint must not mention write_file');`
- `assert.ok(!result.hint.includes('STAGED_DONE'), 'envelope hint must not mention STAGED_DONE');`

> Note: the existing Phase-213 tests (`/pending writes/` at ~3128, ~3164, ~3238, ~3282) and the repeat-sentinel tests (~3388–3552) must continue to pass unchanged — they assert `error` text and non-staged wording that this phase preserves byte-for-byte.

## Done criteria

- [ ] **Implement** the three sites in `src/tool-calls.mjs`, each staged-branched, non-staged wording byte-identical to today:
  - [ ] Site 1 (~353): fresh `const staged = options.inStagedPipeline === true;` declared in the request-building scope; final-turn `content` branched (staged → write_file / STAGED_DONE; non-staged unchanged).
  - [ ] Site 2 (~470 and ~484): one `const staged` declared in the `else` (dispatch) block; both hints replaced with `allowlistWriteHint(staged)`; module-scope `allowlistWriteHint` helper added returning byte-identical non-staged string.
  - [ ] Site 3 (~868–869): `const staged` declared in the `run_command` handler; only the `hint` branched; `error` left byte-identical.
  - [ ] Repeat-sentinel (~428–451) left untouched.
- [ ] **Tests**: six new `it(...)` cases (staged + non-staged per site) added to `test/tool-calls.test.mjs` per the names/assertions above; existing Phase-213 and Phase-220 tests still pass.
- [ ] `npm run format`
- [ ] `npm run test` (full suite green)
- [ ] `npm run check` (`cversion --check` + `build-skills --check`; requires package.json bumped to match max roadmap phase)
- [ ] `process/decisions.jsonl` entry appended: scope = these three sites only; mirrors Phase-220 pattern; why "no write tool" was factually false in staged mode (write_file/edit_file are registered); the DRY decision (one `allowlistWriteHint` helper for the twice-used F1 string, inline ternaries for the single-use sites 1 and 3); error fields kept stable for `/pending writes/` and `Command is not allowlisted:` matchers.
- [ ] Blog post `blog/229-staged-run-command-guard-wording.md` created.
- [ ] **NEXT.md FIFO**: delete the "### run_command pending-write guard: staged-mode wording" candidate (now shipped); update the "## Current frontier (phase 228)" heading and note to phase 229, and add phase 229 to the 213–228 enumeration in the "live work" paragraph.
- [ ] `roadmap.md`: add `- [x] 229 Staged-Aware run_command / Turn-Exhaustion Guard Wording` after the 228 line.
- [ ] `package.json`: bump `"version"` from `0.0.228` to `0.0.229` (must equal max roadmap phase or `cversion --check` fails).
- [ ] **Commit** to the working branch (small, no push), consistent with how phases 227/228 were committed (directly to `main`, not pushed).

## Risks / things to watch

- **Non-staged wording must stay byte-identical.** Any drift in the non-staged branch at sites 1/2/3 (including the `allowlistWriteHint(false)` return) will break existing assertions and the steering contract. Diff the non-staged strings character-for-character against the current file before committing.
- **Do not touch the repeat-sentinel (~428–451).** It is already staged-aware (Phase 220) and has its own tests at ~3320–3562; editing it is out of scope and risks regressions.
- **Keep `error` text stable.** The Phase-213 `error` (`/pending writes/` at ~3128/3164/3238/3282) and the `Command is not allowlisted:` prefix that the dispatch branch keys on (lines ~466, ~480) must not change — only `hint` / branch wording moves.
- **Verify `inStagedPipeline` scope at each site, do not assume.** The only existing `const staged` is at line 428 inside the dispatch `if` branch; it is NOT visible at site 1 (before the loop) nor in the `else` block where sites 2 live. Read the surrounding scope at each site and declare a fresh `const staged` where needed; confirm `options` is in scope (it is the first parameter of `completeWithToolCalls` and a closed-over binding in the `run_command` handler).
- **F1 final-turn test compatibility.** The line-1371 test asserts the appended user message contains `budget`/`exhausted` case-insensitively; both new branches retain the "Turn budget exhausted" prefix, so it stays green — keep that prefix.
- **Version/check coupling.** `npm run check` runs `cversion --check`, which fails if `package.json` ≠ max roadmap phase. Bump package.json to `0.0.229` in the same commit as the `roadmap.md` 229 line so `check` passes.
