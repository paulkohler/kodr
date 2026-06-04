# Phase 83: Compact Subagent Handoffs And Verification

## Goal

Keep planner, implementer, and reviewer conversations isolated without paying
for duplicated context or delegating deterministic verification to the reviewer
model.

## Context

The Phase 82 OpenRouter example completed the requested code correctly, but used
35,005 tokens for a tiny three-file task. The reviewer consumed 19,672 tokens
because the full plan and full proposal were repeated in both system and user
messages, then the reviewer read every generated file and ran the requested
command.

The same run exposed that `--subagent-stages` bypassed Kodr's normal `--install`
and `--test` pipeline. The reviewer model ran `npm test`, but the run summary
still reported `tested: false`.

## Design

- Put stage-specific handoff data in the user message once. Keep system prompts
  stable and role-focused.
- Give the implementer the request, compact workspace context, and plan.
- After applied writes, run dependency installation and verification
  deterministically in the harness.
- Resolve an impossible npm verification command to `node --test` when the
  applied workspace has native Node test files but no `package.json`.
- Give the reviewer a compact write manifest and verification summary, not full
  proposed file contents.
- Keep reviewer read tools available for targeted inspection, but do not ask the
  reviewer to rerun a completed verification command.
- Record install, verification, resolved command, and handoff metadata in
  orchestration artifacts and the top-level run summary.

## Done Criteria

- [x] Remove duplicate plan/proposal content from subagent system and user
  messages.
- [x] Run `--install` and `--test` through the harness during subagent
  orchestration.
- [x] Fall back from npm verification to `node --test` when appropriate.
- [x] Pass a compact write manifest and verification result to the reviewer.
- [x] Record orchestration install/test artifacts and summary fields.
- [x] Add native `node:test` coverage for compact handoffs and verification
  resolution.
- [x] Update usage docs, decisions, failures, blog, roadmap, and version.
- [x] Run format, tests, and check.
- [x] Commit the phase.
