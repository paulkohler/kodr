# Phase 153: Steering the Subagents Toward the Tool Channel

Phase 152 fixed the *code* in the multi-agent path: each subagent's tool-channel
writes (`proposalDraft`) now get merged with its JSON envelope, so a model that
writes via `write_file` / `edit_file` no longer has those writes silently dropped.
But the *prompts* still told every subagent the opposite. Both writing roles ended
with:

> Return **only** a standard Kodr JSON proposal.

That line predates phase 117's capture tools. It steers each subagent *away* from
the channel that now works best, and it actively misleads tool-first models like
gpt-oss into thinking the envelope is the only sanctioned output. This phase is the
prompt-only follow-up: lead with the tool channel, demote the envelope to a
fallback. No code change beyond the regenerated skill bundle.

## The edit

`roles/implementer/SKILL.md` and `roles/file-author/SKILL.md` now open the output
section with the tools:

> Make your changes by calling the write tools — this is the preferred channel and
> the harness captures these writes directly:
> - `write_file` to create a new file or fully replace one.
> - `edit_file` for a small search-and-replace edit to an existing file.
>
> If you cannot call tools, return a standard Kodr JSON proposal instead (the
> fallback channel): …

The JSON schema stays, so an envelope-only model loses nothing — phase 152 merges
either channel, with the envelope winning per path. The planner is untouched: it
runs on a read-only registry and has no business writing files.

A regenerated `src/builtin-skills.json` (via `npm run build-skills`, checked by
`npm run check`) carries the new bodies, and three guard tests in
`builtin-skills.test.mjs` pin the steer in place — they fail if either writing role
ever reverts to "return only a JSON proposal," and assert the planner never grows a
write-tool instruction.

## Before / after on the real model

The risk in a prompt steer is regressing the model that already worked. qwen emits
the envelope and has always been fine, so it's the one to watch. I ran the same
two-file `--subagent-stages` task against qwen before and after the edit:

| | Baseline (old prompts) | After (steered prompts) |
|---|---|---|
| Channel qwen used | **envelope** (`channels=null`) | **tool channel** ("2 files captured via write tools") |
| status | OK | OK |
| files / writeCount | 2 / 2 | 2 / 2 |

The steer didn't break qwen — it *moved* qwen. An envelope-capable model switched
onto the tool channel that phase 152 made safe, delivering the same two files with
the same OK status. That's the whole intent: the channel that now works best is the
one the prompt now recommends, and even a model that didn't need the nudge takes it
cleanly.

An apply-mode run (`--yes`) confirmed the steered path end-to-end: `ok: true`,
`reviewPass: true`, and `src/add.mjs` + `src/multiply.mjs` written correctly to
disk.

## A dry-run red herring

The first after-run was a `--dry-run` and exited non-zero with
`Reviewer blocked completion:` — an *empty* summary. That looked alarming next to a
clean baseline, but it's the dry-run artifact phase 152 already documented: the
advisory reviewer inspects the working tree, and `--dry-run` writes nothing there,
so it sees an empty disk and withholds its pass. The apply-mode run, where the files
actually land, passes review. The block is orthogonal to the capture path — the
implementer's `status: OK` / writeCount 2 is identical in both modes. Worth a note
because it's exactly the kind of "the change broke something" misread that a single
dry-run comparison invites; the fix is to compare in the mode that actually writes.

Full suite 1,473 green (+3 guard tests).
