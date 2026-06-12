# Phase 114 — Environment-Aware System Prompt

The system prompt was 1,737 characters. Identity, envelope contract, a run-on tool sentence, workspace file list. The model had no idea what OS it was on, what shell it would need to target, whether it was in a git repo, or even which model it was. Three rounds of dogfooding had accumulated four observable failure classes with no prompt-side defense.

This phase adds those defenses.

## What the model didn't know

The failure inventory from `process/failures.jsonl` paints a clear picture:

**Multi-block narration** (phases 111, 113-dogfood): gemma-4 routinely emits several `json` blocks in sequence. The first is a planning envelope with empty files/patches; the real content is in blocks 2–3. The harness now extracts all blocks, but the model still burns turns doing this.

**Goal substitution** (phase 113-dogfood): A heal loop with no task anchor invented a passing test for a module that was never requested. The repair context had no record of what the original task was.

**Repeat identical tool calls** (phase 109): A model stuck in a read loop called `read_file` on the same path eight times in a row, exhausting the turn budget without proposing anything.

**Turn budget exhaustion** (phase 109): The model kept exploring rather than writing a proposal until the forced final turn fired. The forced final turn produces lower-quality output than a voluntary proposal.

One prompt line each. Terse and imperative. Every line maps to a concrete failure entry, not to aspirational prose.

## The tool sentence problem

The old contract had this as the last sentence of a paragraph:

> When native tools are available, use inspect_symbols for a compact structural map, find_references for symbol references, read_file for raw file text, read_skill_resource for declared skill resources, run_skill_command only for declared skill helper commands after explicit approval, and run_command only for allowlisted verification commands.

This had two problems. First, it was in the system prompt even in no-tools mode — the phrasing was conditional ("when native tools are available") but the model still read it. Second, it was a run-on sentence with no workflow guidance and no budget reminder.

Phase 114 replaces it with a `# Tools` section — six one-line tool descriptions, a workflow ordering line, and a budget reminder — that only appears when `toolsMode: true`. The no-tools prompt is now clean.

The byte-identity contract between `renderKodrBaseContract()` in `context-packer.mjs` and the patch branch of `renderEditFormatContract()` in `edit-formats.mjs` was kept by updating both together. A comment in each file names the other.

## The environment block

The model was writing `node index.js` (CommonJS assumption), `#!/bin/bash` scripts (bash assumption), and relative paths from the wrong root. All three classes disappear when the model knows:

```
# Environment
- cwd: /path/to/workspace
- git repository: yes (branch main)
- platform: darwin (Darwin 25.5.0), shell: zsh
- node: v24.16.0
- date: 2026-06-12
- model: google/gemma-4-26b-a4b
```

The facts are captured once per run by `captureEnvironmentFacts()` in `src/system-env.mjs` — one `git rev-parse` check and a handful of `process` reads. The same frozen facts object is passed to every `buildWorkspaceContext()` call in a run, making the environment block byte-stable across all context rebuilds within a session. This preserves the prompt-prefix cache hit from phase 87.

## Section ordering

The new section order, most-stable first:

1. **stable** — identity + envelope contract + `# Behaviours` + `# Tools` (tools mode only)
2. **environment** — session-stable facts
3. **project** — AGENTS.md workspace instructions
4. **semiStable** — memory + skills
5. **volatile** — workspace file listing

The `environment` section gets its own hash in `prompt-prefix.json` (`environmentHash`, `environmentChars`). A cache system could cache everything up through `semiStable` and only invalidate on file changes.

## Budget

The phase required the total system message for a standard greenfield task to stay under ~2,900 characters. With the old contract stripped of the tool sentence and the three new sections added, the actual cost for a single-file greenfield task in tools mode is under 2,900 characters. A test guards this: `standard greenfield system message stays under 2900 chars`.

## What stays open

P5 — live two-model A/B validation — is deliberately left unchecked. It runs after the commit, comparing old and new prompts on the standard wordfreq greenfield task with gemma-4 and gpt-oss-20b. The done criterion is: no regression on success rate and at least one observable improvement (fewer narration blocks, correct shell/Node assumptions in generated commands).
