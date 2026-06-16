# Phase 153 — Steer Subagent Roles Toward the Tool Channel

## Motivation

Phase 152 fixed the *code*: `resolveProposalFromCompletion` now merges each
subagent's `proposalDraft` (tool-channel writes) with its JSON envelope, so an
implementer or file-author running on a tool-only model no longer has its writes
dropped. But the *prompts* still steer the wrong way. Both role skills say:

> Return **only** a standard Kodr JSON proposal.

That instruction predates phase 117's capture tools. It tells every subagent to
avoid the channel that now works best, and it actively misleads tool-first models
(gpt-oss writes via tools and emits no envelope) into thinking the envelope is the
only sanctioned output. The code tolerates either channel; the prompt should
*prefer* the tool channel and present the envelope as the fallback.

This is the prompt-only follow-up named in NEXT.md after 152. No code changes.

## Change

Edit `src/builtin-skills/roles/implementer/SKILL.md` and
`src/builtin-skills/roles/file-author/SKILL.md`:

- Lead with the write tools: `write_file` to create or fully replace a file,
  `edit_file` for a search-and-replace edit to an existing file. State that these
  are captured directly and are the preferred way to make changes.
- Demote the JSON proposal to an explicit fallback "if you cannot call tools,"
  keeping the schema so envelope-only models (qwen) are unaffected — the harness
  merges tool writes with any envelope, envelope winning per path (phase 152).
- The planner stays read-only (`createReadOnlyRegistry`); do not steer it to write.

Rebuild the bundle: `npm run build-skills` regenerates `src/builtin-skills.json`
(verified by `npm run check`).

## Testing

- `npm run check` (includes `build-skills --check`) confirms the regenerated
  bundle is committed and in sync with the SKILL.md sources.
- Existing `skills`/orchestration tests stay green (no API/schema change).
- Local before/after comparison (AGENTS.md live-validation): a `--subagent-stages`
  run against **qwen** (the envelope-path model — the regression risk) must still
  produce both files with `status: OK`. Baseline (pre-steer) captured under
  `~/src/kodr-testing/phase-153/baseline-qwen`; after-steer run compared.

## Done criteria

- [x] Both role SKILL.md files lead with the tool channel; envelope demoted to
      fallback; schema retained.
- [x] `src/builtin-skills.json` regenerated and committed.
- [x] `npm run format` + `npm run check` + full suite green (1,473 — +3 guard
      tests).
- [x] Local qwen `--subagent-stages` comparison: the steer moved qwen from the
      envelope channel onto the tool channel ("2 files captured via write tools")
      with no regression — both files, `status: OK`, writeCount 2; apply-mode run
      `ok: true`, `reviewPass: true`, correct files on disk. (The dry-run
      after-run's reviewer block was the known dry-run artifact — empty disk for
      the advisory reviewer — confirmed independent of the steer by the clean
      apply-mode pass.)
- [x] Blog `blog/153-*`; decisions entry; NEXT.md item removed; roadmap line;
      version 0.0.153.
