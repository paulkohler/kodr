# Phases 90–93: Hybrid Skill-Driven Orchestration

## The problem with small local models

The `--subagent-stages` pipeline was already planner → implementer → reviewer.
But the implementer looped over all files in *one accumulating context*, so by
file 4 the window was clogged with files 1–3. On a 35B-parameter Qwen model,
that distillation is fatal — responses become vague or miss half the contracts.

## What changed

Four phases landed together because they are tightly interdependent.

### 90 — Builtin skills bundle

Persona SKILL.md files live in `src/builtin-skills/roles/`. A new
`bin/build-skills.mjs` script reads them, parses with the existing
`parseSkillMarkdown`, and writes `src/builtin-skills.json`. The JSON is
committed and `npm run check` now includes `build-skills --check` to catch drift.

`src/builtin-skills.mjs` exposes `getBuiltinSkill(name)` backed by a JSON
import with `{ type: 'json' }`. Returning `structuredClone` prevents accidental
shared-object mutation across callers.

The packaging problem: `discoverSkills` scans `cwd`, so after
`npm run install-local` running Kodr in any other directory finds zero skills.
Bundling roles as JSON fixes this — they are always present wherever the shim
points.

### 91 — Structured plan manifest

The planner's output was free-form prose parsed by a fragile regex
(`extractPlanManifest`). Now the planner SKILL.md instructs the model to emit a
JSON manifest:

```json
{
  "summary": "...",
  "files": [
    { "path": "...", "responsibility": "...", "exports": [...], "imports": [...] }
  ]
}
```

`parsePlanManifest` extracts this from the planner's text response using the
existing `extractJson`. The regex extractor remains as a fallback when the model
returns prose — resilience for weak models is non-negotiable.

`plannerResponseFormat()` is defined in `structured-output.mjs` for providers
that support strict JSON schemas, but it is stripped for local+tools requests
by `shouldOmitResponseFormat`, so the prompt-text instruction is the primary
path for LM Studio.

### 92 — Isolated file-author subagents

`runImplementerAgent` now checks for `options.planManifest`. When present, it
routes to `runIsolatedFileAuthors` instead of the shared-context pass-loop.

Each file in the manifest gets its own `runFileAuthorAgent` call with a fresh
`createBuiltinRegistry`. The context for a file-author is:

- Plan summary (one paragraph, not the full plan)
- Its own contract: path, responsibility, exports to provide, imports from siblings
- Sibling **export signatures** from the manifest — never sibling file bodies

This is the context firewall. File A's author never sees file B's code, only
B's interface. As long as the planner's contracts are accurate, the authors
stay coherent without polluting each other's context.

The fallback to the old shared-context loop is automatic when `parsePlanManifest`
returns null, so existing tests (which use free-form planner responses) continue
to pass unchanged.

### 93 — Persona from skill

`buildAgentSystemPrompt` now calls `getBuiltinSkill('role:' + agentName)` first
and falls back to the `prompts/orchestration-*.md` files. Role bodies are
trusted harness content, injected directly into the system prompt — not run
through the untrusted-workspace warning path.

`AGENTS` is updated in both `orchestration.mjs` and `model-specs.mjs` to include
`file-author`, so `--agent-model file-author=lmstudio/my-model` is valid. The
`splitAgentDirectives` regex also recognises `file-author:` directives.

## What the test suite checks

- `build-skills --check` passes against the committed JSON (drift guard)
- All four roles resolve with non-empty bodies; mutations don't affect the bundle
- `parsePlanManifest` handles structured JSON and falls back to null for prose
- `runPlannerAgent` populates `manifest` when the response contains JSON
- `runFileAuthorAgent` context contains sibling signatures but NOT sibling bodies
- `runSubagentStages` with a structured manifest emits `file-author` progress
  events and writes both files
- All 19 legacy orchestration tests still pass (fallback path)

## Failures to record

None during this batch. The only snag was that `biome format` reformatted
`bin/build-skills.mjs` after the initial JSON was generated, causing
`build-skills --check` to fail on first `npm run check`. Fix: always run
`npm run build-skills` after `npm run format`.
