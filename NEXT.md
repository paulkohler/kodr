# NEXT

Loose, forward-looking candidates only — the rough shape of phases not yet
written. Not a commitment; promote an item into `roadmap.md` + `phases/` when
it is actually next. **Delete an item the moment it ships** — history lives in
the roadmap, phase files, and blog, not here. If a cut idea was really needed it
will resurface on its own.

Current frontier (phase 147): the plumbing works — extraction, transport,
channels and routing are hardened against real local-model output. The live
failures are now in the *code the local models write* and at *transport edges*
(token-limit truncation, role alternation).

## Candidates

### Per-step model routing
`--route-auto` (141) picks the best-history model at run start. The open half is
splitting *within* a run: cheap tasks (commit messages, compaction, summaries)
to a `cheapModel`, edits to `editModel`, recording the per-step choice in the
summary so `kodr why` shows which model handled which step. Bigger and riskier —
it touches several internal model-call sites; the `cheapModel` recommendation
can extend `recommendModel`.

### Partial: steer subagent SKILL.md toward the tool channel
Phase 152 fixed the orchestration envelope-island bug (implementer/file-author now
merge `proposalDraft` via `resolveProposalFromCompletion`, so tool-channel writes
are no longer dropped). Remaining, prompt-only follow-up: update
`roles/implementer` and `roles/file-author` SKILL.md to "write via tools; the JSON
envelope is fallback," so tool-only models are steered toward the channel that now
works. Low-risk; validate the steer doesn't regress qwen's envelope path.

### Multi-file coordinated edits
The eval suite only measures single-defect fixes. Plant a cross-file refactor
fixture and measure it — this exposes whether plan manifests (91) and
file-author subagents (92) actually compose. Bigger swing. **Requires a retest**
— re-validate that this is still a gap against current plan-manifest/subagent
behaviour before promoting it to a phase.

### Re-decide the @kodr/repomap publish hold
Parked by decision (2026-06-12: no publish until more dogfooding); the
precondition is now met, so this needs a human call and won't resurface on its
own. The `packages/repomap/src/` tree is a manual copy of `src/repomap/`; a sync
check (a test that fails when the trees diverge) can land regardless of the
publish decision.
