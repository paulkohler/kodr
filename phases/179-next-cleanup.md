# Phase 179: NEXT.md Cleanup (post-178 retrospective)

## Motivation

Phases 177 (hook uninstall) and 178 (secret sensor tuning) shipped. NEXT.md still
listed them as candidates and named an outdated frontier. Cleanup keeps the file
useful as a planning surface.

## What this phase does

- Removed shipped items: `kodr hook uninstall`, secret sensor false-positive tuning.
- Updated frontier paragraph to phase 178.
- Added new candidates: sensor name registry, `kodr hook status`, `kodr check`
  TTY summary line, cross-workspace cycle detection (--deep opt-in).
- Retained: smoke-check heal integration, per-step model routing, repomap
  publish re-decision.

## Done criteria

- [x] Shipped candidates removed from NEXT.md.
- [x] Frontier updated to phase 178.
- [x] New candidates documented.
- [x] Committed.
