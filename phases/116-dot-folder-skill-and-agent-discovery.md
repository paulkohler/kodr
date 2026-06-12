# Phase 116 — Dot-Folder Skill And Agent Discovery

## Motivation

Kodr discovers skills by walking the workspace tree for `SKILL.md` files
(`discoverSkills` → `listContextFiles`). That misses the places people
actually keep this material:

- `.kodr/` is ignored wholesale (`KODR_IGNORE_PATTERNS`), so kodr cannot even
  host its own project skills under `.kodr/skills/`.
- User-level directories (`~/.claude/skills/`, `~/.kodr/skills/`) are never
  consulted — discovery only walks the cwd.
- Claude Code agent files (`.claude/agents/<name>.md`: frontmatter
  name/description/model + body-as-system-prompt) are a different format and
  are invisible to kodr entirely — this repo's own
  `.claude/agents/kodr-test-operator.md` being a live example.

The practical ask: kodr should pick up skills and agents from the common dot
folders (its own `.kodr/` and Claude Code's `.claude/`, project- and
user-level), plus an override parameter so existing Claude Code paths can be
used directly — no symlink farms.

This is a security-boundary feature (kodr will read prompt material from
outside the workspace): per AGENTS.md it must be checked against the real
external tool's documented semantics (Claude Code's actual `.claude/skills/`
and `.claude/agents/` layouts — real examples exist at `~/.claude/skills/`
and `/Users/paul/src/koder-by-codex/.claude/agents/`) and validated with a
real integration run.

## Work items

### K1 — Skill search-path tiers

Replace incidental whole-tree-only discovery with an explicit, data-driven
search-path list, highest precedence first:

1. Override dirs (K3), in the order given.
2. Workspace tree `SKILL.md` discovery (existing behaviour, unchanged).
3. Project dot folders: `.kodr/skills/`, `.claude/skills/` (layout:
   `<dir>/<name>/SKILL.md`).
4. User dot folders: `~/.kodr/skills/`, `~/.claude/skills/`.

First hit per skill name wins; lower-tier duplicates are recorded as shadowed
(name, both paths) rather than silently dropped. Claude Code `SKILL.md`
frontmatter (name/description, no commands/resources keys) must parse with
the existing parser unchanged. The existing per-skill/total byte budgets
apply across all tiers. Missing dirs are skipped silently; unreadable files
are reported, not fatal. The tier list itself is one exported array so
future conventions are a data edit.

### K2 — Agent-file discovery

Discover agent specs from `.kodr/agents/*.md`, `.claude/agents/*.md`,
`~/.kodr/agents/`, `~/.claude/agents/` (same precedence shape as K1; K3
overrides apply). Parse Claude Code's format: YAML frontmatter `name`,
`description`, `model` (optional, may be an alias like `sonnet` that does
not map to a kodr model spec — keep it as metadata, warn only when someone
tries to use it), unknown keys preserved in `frontmatter`; body is the
agent's system prompt.

Wire-up, deliberately minimal:

- `kodr run --agent <name>` applies the agent body as the persona layer of
  the system prompt (the same slot phase 93's role skills occupy), keeping
  the envelope/tools/environment blocks intact. `--model` still wins over
  the agent's `model` frontmatter; if the frontmatter model parses as a
  valid kodr model spec (`parseSlashModelSpec`) it is used as the default,
  otherwise ignored with a stderr note.
- If a discovered agent's name matches an orchestration role (planner,
  implementer, file-author, reviewer), it overrides the builtin `role:` skill
  for that run — a new first tier in phase 93's fallback chain.
- Unknown `--agent <name>` fails fast listing available agent names.

### K3 — Override parameter

`--skills-dir <path>` and `--agents-dir <path>` (repeatable) plus config
keys `skillsDirs` / `agentsDirs` (string arrays) in `.kodr/config.json`.
Flags and config *prepend* to the default tiers (they don't replace them —
the user's stated goal is pointing at existing Claude Code paths without
symlinks, not disabling defaults). Paths resolve relative to cwd; config
values pass the existing project-config validation style (reject non-string
entries loudly).

### K4 — Resource jail per skill root

`read_skill_resource` / skill resources currently jail to the workspace.
Out-of-tree skills (user-level or override dirs) must jail resource reads to
**that skill's own directory** — a skill at `~/.claude/skills/foo/` may read
`~/.claude/skills/foo/refs/x.md`, never `~/.claude/skills/bar/` or anything
above its root. Reuse `jailedPath` with the skill root as the jail. Skill
commands (`run_skill_command`) keep their existing explicit-approval gate
regardless of origin; the skill's source path appears in the approval
surface so the user can see *where* the command came from.

### K5 — `kodr skills` listing

New CLI command `kodr skills`: lists discovered skills and agents — name,
one-line description (truncated), source path, tier label (override /
workspace / project / user), and any shadowed collisions. `--json` for the
machine view. This is the verification surface for the whole phase.

## Testing

- Tier precedence: same skill name in two tiers → higher tier wins, shadow
  recorded; override dir beats workspace.
- Claude Code `SKILL.md` (name/description only) parses; kodr SKILL.md with
  commands/resources keeps working.
- Agent-file parsing: full frontmatter, missing optional keys, model alias
  that doesn't map (kept as metadata), body extraction.
- `--agent` wiring: persona layer swapped, envelope/tools blocks intact
  (prompt assembly assertions), unknown name fails with the roster, role-name
  agent overrides the builtin role skill.
- K4 jail: resource path escaping the skill root throws `SafeWriteError`;
  in-jail resource read works from a user-level dir (tmp fixture standing in
  for `~`; home resolution must be injectable for tests).
- Config validation: bad `skillsDirs` entries rejected by name.
- `kodr skills` output snapshot incl. `--json`.
- Full suite, `npm run format`, `npm run check` green.

## Done criteria

- [x] K1: tiered skill discovery with precedence + shadow records.
- [x] K2: agent files discovered and usable via `--agent`; role-name agents
      override builtin role skills.
- [x] K3: `--skills-dir`/`--agents-dir` flags + `skillsDirs`/`agentsDirs`
      config keys, prepended to defaults.
- [x] K4: per-skill-root resource jail for out-of-tree skills; command
      approval surface shows skill origin.
- [x] K5: `kodr skills` lists skills + agents with provenance and tiers.
- [x] Real-format check: parses actual files from `~/.claude/skills/` and
      `.claude/agents/` (this repo) without error.
- [x] `process/failures.jsonl` / `process/decisions.jsonl` updated.
- [x] Blog post `blog/116-dot-folder-skill-and-agent-discovery.md`.
- [x] NEXT.md entries shipped by this phase deleted (FIFO), if any apply.
- [x] Version bumped to 0.0.116; suite green; committed.
- [x] Live validation (after the commit, sequential, gemma): a test workspace
      with a project `.claude/skills/<x>/SKILL.md` and `.claude/agents/<y>.md`
      — `kodr skills` lists both with correct tiers; a run requesting the
      skill shows it in the packed context; a `--agent <y>` run uses the agent
      body as persona and completes; `--skills-dir` pointed at the real
      `~/.claude/skills` lists those skills (read-only check, no run needed).
      RESULT — core criteria all passed on the first pass (skill marker in
      packed context; agent persona applied with envelope/tools/environment
      blocks intact; gemma runs completed). The real-`~/.claude/skills`
      check earned its place by finding three defects, all fixed in
      follow-up commits: symlinked skill dirs were invisible
      (readdir Dirent.isDirectory() is false for symlinks — ironic for a
      feature meant to end symlink farms), Claude Code model aliases like
      `sonnet` parsed as literal model ids (would have been sent to the
      server on `--agent` runs without `--model`), and the 40KB context
      byte budget terminated discovery enumeration so the listing showed 5
      of 15 real skills (now metadata-only past the budget, reloaded on
      explicit request). Known limitation recorded: YAML folded
      `description: >` scalars list as a literal '>'. Evidence:
      `~/src/kodr-testing/phase-116/` (OPERATOR-REPORT.md),
      `process/failures.jsonl` phase 116-validation.
