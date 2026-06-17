# Phase 176: NEXT.md Cleanup (post-175 retrospective)

## Motivation

NEXT.md was last updated at phase 167. Phases 168–175 shipped several items that
were in the candidates list. The frontier description was stale.

## What this phase does

**`NEXT.md`**:
- Updated frontier: describes `kodr check` as now complete with all five sensors
  (`compose-dockerfile`, `css-selector`, `local-import`, `import-cycles`,
  `secret-in-response`) and all flags (`--json`, `--strict`, `--changed`,
  `--watch`, `[dir]`). Notes `kodr hook install` as shipped.
- Removed shipped candidates:
  - `kodr check --changed` (shipped: phase 171)
  - Import cycle detection (shipped: phase 172)
  - Secret-in-response sensor (shipped: phase 173)
- Kept:
  - Smoke-check heal integration (still open, architectural challenge unchanged)
  - Per-step model routing (still open, bigger scope)
  - @kodr/repomap publish hold (still needs a human call)
- Added new candidates from review:
  - `--json` sensor name canonicalisation (small, useful for CI scripts)
  - Cross-workspace cycle detection (extension of phase 172)
  - `kodr hook uninstall` (low priority counterpart to phase 174)
  - Secret sensor false-positive tuning (blocklist / suppression annotation)

## Done criteria

- [x] NEXT.md frontier matches phase 175 reality.
- [x] Shipped items removed.
- [x] New candidates documented.
- [x] Decisions logged; roadmap checked; version bump; committed.
