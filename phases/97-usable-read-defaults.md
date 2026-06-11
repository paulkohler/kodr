# Phase 97: Usable Read Defaults

## Goal

Turn on by default the paths that are read-only or already bounded, so a bare
`kodr run -p "task"` behaves like a coding harness instead of a demo. Write
gating does not change: dry-run before writes stays the constitution.

The distinction this phase enforces is read effects vs write effects. Tools
that list/read, streaming output, and inspection-aware packing have no write
effect and no safety reason to be opt-in. Apply, install, and command
execution keep their existing gates.

## Design

- `--tools` resolves to `auto` through the model profile registry (phase 69):
  profiles marked tool-capable get tools on by default, others stay off.
  `--no-tools` forces off; explicit `--tools` forces on. Tool *effects* that
  write or execute remain gated by the permission policy exactly as today.
- `--stream` defaults on when stdout is a TTY and `--json` is not set.
  `--no-stream` forces off. Non-TTY and JSON output are unchanged.
- Inspection-aware context packing (phase 52) becomes the default strategy
  when the structural index succeeds for the workspace; whole-file packing is
  the fallback and stays selectable with `--no-inspect-context`. The packed
  context summary records which strategy ran and why.
- `--heal` defaults on when both `--yes` and `--test` are present — the user
  asked for apply-and-verify, and the repair loop is already bounded.
  `--no-heal` opts out.
- Every new default has a `--no-*` escape and is overridable from the phase
  96 project config.
- README and usage.md Safety Defaults sections updated to state the new
  defaults and the unchanged write gates.

## Non-Goals

- No change to `--yes`, `--install`, sandbox flags, or skill command
  approval.
- `--subagent-stages` stays opt-in (expensive, model-dependent).

## Done Criteria

- [ ] Tools default resolves per model profile with both overrides tested.
- [ ] Stream defaults on for interactive TTY only.
- [ ] Inspect-context is the default packing strategy with recorded fallback.
- [ ] Heal defaults on for `--yes` + `--test` runs.
- [ ] Write/exec gates verified unchanged by tests.
- [ ] Docs updated.
- [ ] Record decisions and any failures.
- [ ] Blog post.
- [ ] Mark roadmap complete and commit.
