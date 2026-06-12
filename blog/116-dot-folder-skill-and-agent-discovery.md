# Phase 116 — Dot-Folder Skill And Agent Discovery

Kodr has had skills since Phase 07. It has had subagent roles since Phase 30. It has never known about its own agent files.

The irony: `.claude/agents/kodr-phase-implementer.md` tells Claude Code how to run Kodr development phases. `.claude/agents/kodr-test-operator.md` tells it how to run live validation. Both files live in the Kodr repo. Kodr itself couldn't see them. Pass `--agent kodr-phase-implementer` and Kodr would error out before making a single model call. This phase fixes that.

## The discovery problem

Skills had one tier: workspace. Kodr walked the current directory recursively looking for `SKILL.md` files. That was the right design for Phase 07, when skills were a new concept and workspace scope was the natural boundary. It becomes wrong the moment you want to install a skill globally — in `~/.claude/skills/` — without copying it into every project.

Claude Code solved this with a four-tier lookup: workspace, project dot-folders, user dot-folders, and override dirs. Kodr now does the same.

The tier order is `['override', 'workspace', 'project', 'user']`. First hit per name wins. A skill in an override dir shadows a workspace skill with the same name; a workspace skill shadows a project or user skill. This is not just a nice-to-have — it is what makes the system composable without coordination.

## Skills: the tiered implementation

`discoverSkillsTiered` is a new export from `skills.mjs`. It returns `{ skills, shadows }`.

- **Override tier**: any dirs passed via `--skills-dir` or `skillsDirs` config. Scanned first.
- **Workspace tier**: the existing recursive `SKILL.md` walk. Unchanged.
- **Project tier**: `.kodr/skills/<name>/SKILL.md` and `.claude/skills/<name>/SKILL.md` in the project root.
- **User tier**: same dot-folder layout under the home directory.

Each skill carries a `tier` property (`'override' | 'workspace' | 'project' | 'user'`) and an `absoluteRoot` property. For dot-folder and override skills, `absoluteRoot` is the directory containing the skill's `SKILL.md`. For workspace skills it is null, and the existing `dirname(skill.path)` relative to cwd continues to apply.

Shadow records capture what was displaced. Each shadow has `name`, `winnerTier`, `shadowTier`, `winnerPath`, and `shadowPath`. The `kodr skills` command surfaces them so users can see what is being overridden and why.

The backward-compat `discoverSkills` wrapper keeps its workspace-only fast path when no override dirs are specified. This is not laziness — it is isolation. The full tiered scan reads from the real `~/.claude/skills/` directory, which is populated on developer machines. A wrapper that activated tiered scan unconditionally would inject ambient installed skills into every test assertion. The fast path stays; tiered scan activates only when the caller opts in.

## Agents: a new module

`src/agents.mjs` is new. It exports `discoverAgents`, `parseAgentMarkdown`, `findAgent`, `isOrchestrationRole`, and `AgentError`.

The agent file format is Claude Code's YAML-frontmatter markdown: a `---`-delimited block containing `name`, `description`, and optionally `model`, followed by a markdown body that becomes the system prompt. Kodr already used this format internally; the module makes it first-class.

Discovery scans the same dot-folder structure as skills: override dirs (`--agents-dir`), then `.kodr/agents` and `.claude/agents` in the project root, then the same pair under home. First-hit-per-name wins, same as skills.

Model handling gets careful treatment. An agent's `model` field might be a valid Kodr model spec — like `lmstudio/qwen3-235b` — or a Claude Code alias like `sonnet`. Both are stored. When `--agent` is passed and the agent's model is an alias Kodr doesn't recognize as a valid spec, Kodr warns and ignores it rather than crashing. When the agent specifies a valid Kodr spec, that spec is applied to `options.model` — but only if `--model` was not explicitly set on the command line.

## Threading --agent into prompt assembly

The path from `--agent` to the final request body:

1. `parseArgs` adds `agent: ''` and `agentsDirs: []` defaults.
2. In `runPrompt`, `discoverAgents` is called with `resolvedAgentsDirs(options, cwd)`.
3. `findAgent` matches by name. If not found, it throws `AgentError` with the full agent roster.
4. The agent spec is stored as `agentPersona` and passed into `buildWorkspaceContext`.
5. `buildWorkspaceContext` sets `context.agentPersona = options.agentPersona`.
6. `renderProjectPromptSection` (in `context-packer.mjs`) emits an `<agent-persona>` XML block after the AGENTS.md block.
7. For orchestration roles, `agentRoleOverrides` is built from the agent spec and passed to `buildAgentSystemPrompt` as its fourth argument.

The persona injection lives in the project-prompt section, not in the kodr-core section. This keeps the stable prefix (kodr-core, environment, skills) byte-identical across runs with and without an agent, which matters for prompt-prefix caching (Phase 87). Only the project section changes.

## K3: flag and config merging

`--skills-dir` and `--agents-dir` are repeatable flags. Each occurrence appends to the corresponding array. Config file entries in `skillsDirs` and `agentsDirs` are merged after CLI values, so CLI always wins precedence in the first-hit-per-name scheme.

The merge rule in `applyProjectConfig`: if `options[key].length > 0` (CLI values present), the result is `[...options[key], ...configValue]`. If CLI is empty, config values are set directly. No replacement, no surprise.

## K4: per-skill-root resource jail

Out-of-tree skills need their own file-access boundary.

A user skill at `~/.claude/skills/myskill/SKILL.md` should be able to reference `./scripts/run.sh` relative to `~/.claude/skills/myskill/`, not relative to the current project. Before this phase, `jailedPath` always resolved against the workspace root — which means a user skill's relative paths would resolve inside the project, and the jail check would reject paths that tried to escape to where the skill actually lived.

The fix: each skill's `absoluteRoot` is used as the jail root in `loadSkillResource` and `runSkillCommand`. For workspace skills where `absoluteRoot` is null, the existing `join(cwd, dirname(skill.path))` behavior is preserved. The approval surface also now includes `skillSourcePath` and `skillTier` so users can see where a command originated before granting permission.

## K5: kodr skills command

`kodr skills` discovers all skills and agents and prints them. `--json` emits a machine-readable structure with `skills`, `shadows`, `agents`, and `agentShadows` arrays. Human output groups by tier and marks shadowed entries.

This is the inspect-before-run workflow for the discovery system: see what is available, see what is being shadowed, confirm the right skill is active before running a prompt that depends on it.

## What changed in tests

Test count went from 1038 to 1085 — 47 new tests across `test/agents.test.mjs` (new file), `test/app.test.mjs` (K3 parseArgs, renderSkillsListing, kodr skills command), and `test/project-config.test.mjs` (skillsDirs/agentsDirs config keys).

Three issues surfaced during the test run:

**Real home directory contamination.** After the first implementation, existing discoverSkills tests failed because real `~/.claude/skills/` entries appeared alongside test fixtures. The fix was the backward-compat fast path described above. Tests that wanted tiered behavior create synthetic home directories with `mkdtemp` and pass `homeDir` explicitly so the real `~` is never touched.

**Leading newlines in agent body.** `raw.slice(end + 4)` — where `end + 4` is the position after the closing `---` — includes the newline that terminates the fence line. When test input had a blank line between `---` and the body, two newlines were captured. Changed the strip regex from `/^\n/u` to `/^\n+/u`.

**homeDir === cwd shadow collision.** Early tests set `homeDir: cwd` to avoid touching the real home. This caused project-tier dot-folder paths and user-tier dot-folder paths to point at the same directory, making every agent appear twice and create spurious shadow records. Fixed by creating a separate `fakeHome` with `mkdtemp`.

## The origin story

Kodr's own `.claude/agents/` specs were invisible to Kodr. The tool that phases are implemented with could not consume the role files that describe how to implement phases. This phase closes that gap. The next time someone runs `kodr run --agent kodr-phase-implementer "implement phase 117"`, the agent persona will be in the system prompt.
