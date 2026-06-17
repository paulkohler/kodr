# Phase 168: NEXT.md Cleanup

## Motivation

NEXT.md had stale entries describing work that shipped in phases 158–167:
- "Deterministic cross-reference sensors" — fully shipped (158–159).
- "Multi-file refactor eval fixture" — shipped (162).
- "Smoke-check follow-ups / network errors" — the network-error case shipped
  (161); the heal-integration and sandbox-routing cases remain open.

The file also referenced phase 147 as the current frontier (9 phases behind).

## What this phase does

- Removed the stale "Deterministic cross-reference sensors" candidate section
  (shipped as phases 158–167, including compose, css, and local-import sensors).
- Removed the "Multi-file refactor eval fixture" candidate (shipped as phase 162).
- Updated the frontier note to phase 167 with a summary of what shipped.
- Rewrote "Smoke-check follow-ups" to focus only on the two open items: heal
  integration and sandbox routing (network errors closed in phase 161, noted).
- Added "Import cycle detection" and "Secret-in-response sensor" as new
  candidates generated from post-167 retrospective.
- Kept "Per-step model routing" and "Re-decide @kodr/repomap publish hold"
  unchanged (still open).

## Done criteria

- [x] Shipped items removed from NEXT.md.
- [x] Frontier comment updated to phase 167.
- [x] New candidates added for post-167 ideas.
- [x] Committed.
