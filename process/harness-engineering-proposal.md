# Harness Engineering Proposal for Kodr

Mapping Böckeler/Fowler's harness engineering taxonomy to the kodr codebase,
identifying gaps, and proposing concrete changes to make kodr opinionated about
its own harness loop.

## 1. Current State Mapping

Every existing kodr feature classified as Guide or Sensor, Computational or
Inferential, with the source module.

### Guides (Feedforward — steer before the agent acts)

| Feature | Comp/Inf | Module | Notes |
|---|---|---|---|
| AGENTS.md injection | Inferential | `context-packer.mjs` | Loaded into system prompt as `<workspace-instructions>` |
| KODR_MEMORY.md | Inferential | `memory.mjs` | Project memory, 12KB cap, treated as untrusted context |
| User memory (.kodr/memory/user.md) | Inferential | `memory.mjs` | Private local context |
| Markdown skills | Inferential | `skills.mjs` | Loaded skill bodies injected into system prompt |
| Inspection-aware context packing | Computational | `context-packer.mjs`, `repomap/` | Ranked symbol index selects relevant code chunks |
| Repomap structural index | Computational | `repomap/inspector.mjs` | Regex-based symbol extraction per language |
| LSP enrichment (symbols + diagnostics) | Computational | `lsp-client.mjs` | Document symbols, diagnostics via LSP stdio |
| External inspector registry | Computational | `external-inspector-registry.mjs` | Discovers gopls, pyright, rust-analyzer, ts-langserver |
| Inspection task plan | Both | `task-plan.mjs` | Identifies target files/symbols from prompt + index |
| Prior scratchpad injection | Inferential | `app.mjs` | Previous run's scratchpad fed into next prompt |
| Session compaction | Inferential | `session-compaction.mjs` | Summarised prior conversation as guide context |
| Model profile defaults | Computational | `model-profiles.mjs` | Caps, format, timeout per model family |
| Kodr base contract prompt | Inferential | `context-packer.mjs` | The `renderKodrBaseContract()` system prompt |
| Staged execution plan stage | Inferential | `app.mjs` (runStagedPrompt) | First turn asks for plan only, subsequent turns implement |

### Sensors (Feedback — observe after the agent acts, enable self-correction)

| Feature | Comp/Inf | Module | Notes |
|---|---|---|---|
| Verification runner | Computational | `verification-runner.mjs` | Allowlisted test commands (npm test, node --test, go test, cargo test) |
| Self-healing loop | Both | `healing.mjs` | Bounded repair turns: model proposes fix → re-verify |
| Workspace snapshot diff | Computational | `healing.mjs` | SHA256 before/after each repair turn to detect no-progress |
| No-progress detection (healing) | Computational | `healing.mjs` | 2 consecutive no-change turns → stop |
| Wrong-path detection (healing) | Computational | `healing.mjs` | Writes must touch a failure path extracted from test output |
| Proposal extraction + validation | Computational | `json-extractor.mjs` | Validates envelope shape, catches malformed JSON |
| Safe writes path jailing | Computational | `safe-writes.mjs` | Prevents path traversal outside workspace |
| Protect-existing gate | Computational | `safe-writes.mjs` | Refuses to overwrite files not in proposal |
| Apply approval prompt (TTY) | Human | `app.mjs` | Interactive y/N gate before writing |
| Command hooks (pre/post tool use, stop) | Computational | `command-hooks.mjs`, `hooks.mjs` | User-configured external commands at lifecycle points |
| Subagent reviewer | Inferential | `orchestration.mjs` | Advisory LLM review of implementer output |
| Git tree state check | Computational | `git-workspace.mjs` | Records clean/dirty before writes |
| Undo system | Computational | `undo.mjs` | Reverts applied writes using backup manifests |
| Run artifacts / forensics | Computational | `artifacts.mjs` | Every request, response, write persisted to run dir |
| Eval suite scorer | Both | `eval.mjs`, `eval-runner.mjs` | Assertion-based scoring of proposals |

### What Is Neither Guide Nor Sensor (Infrastructure)

These are execution primitives, not harness controls:

- Model client (`model-client.mjs`) — HTTP transport
- Tool call dispatch (`tool-calls.mjs`) — ReAct loop plumbing
- Docker/OpenShell sandboxes — isolation, not regulation
- Server/TUI/CLI channels — UI, not control
- Prompt caching — performance optimisation
- Continuation/streaming — transport


## 2. Gap Analysis

### Gap A: LSP diagnostics are collected but never fed back

`lsp-client.mjs` collects `publishDiagnostics` (errors, warnings) during the
`enrichFile` pass. These diagnostics are stored in the inspection index but
**never routed into the repair loop or the model prompt**. The LSP sensor
fires, but its output goes nowhere the agent can see.

This is the single biggest missed sensor. LSP diagnostics are the same
signals a human developer sees as red squiggles — type errors, unresolved
imports, unused variables. They are computational, fast, deterministic, and
free. Kodr already pays the startup cost of an LSP server; it just discards
the diagnostic output before the model can act on it.

### Gap B: LSP is opt-in (off by default)

`options.lsp` defaults to `false`. The `inspectWithRegistry` function skips
all LSP entries unless `options.lsp` is truthy. This means the richest
computational guide (LSP document symbols with hierarchical detail) and the
richest computational sensor (LSP diagnostics) are both OFF unless the user
passes `--lsp`.

Fowler's "keep quality left" principle says: run cheap checks before commit.
LSP checks are cheap (the server is already installed if you use VS Code
or any editor with language support). They should be on by default when the
server binary is available.

### Gap C: No post-write computational sensor

The flow is: model proposes → writes applied → test command runs → heal if
failed. But there is no intermediate "re-inspect the written files" step.
After writes land, kodr could re-run the LSP or the regex inspector on just
the changed files and catch type errors, unresolved imports, or syntax errors
*before* running the full test suite. This would catch the class of errors
where the model writes syntactically valid but semantically broken code that
the test suite takes 30 seconds to detect.

### Gap D: Diagnostics never formatted for LLM consumption

When Fowler says sensors are "particularly powerful when they produce signals
that are optimised for LLM consumption," she's describing exactly what kodr
doesn't do with lint/type output. Test runner stderr is dumped raw. LSP
diagnostics (when collected) are structured JSON but never rendered into a
prompt-friendly format. A human reading a test failure knows to look at the
assertion line; the model gets a wall of TAP output.

The healing loop's `renderLoopRepairPrompt` includes test JSON and file
content, but it doesn't include:
- Structured diagnostic summaries ("3 type errors in src/foo.mjs: line 12
  unresolved import, line 45 type mismatch...")
- Delta between previous and current failure ("2 of 5 errors fixed; 3 remain")
- LSP diagnostics for the files just written

### Gap E: No explicit harness abstraction in code

The harness loop is implicit — spread across `app.mjs` (`runPrompt`,
`runHealingIfNeeded`, `createInspectionContext`), `healing.mjs`, and
`verification-runner.mjs`. There is no module that represents "the harness"
as a first-class concept. This makes it hard to:

1. Add new sensors without touching the 4000-line `app.mjs`
2. Configure which sensors run at which lifecycle point
3. Reason about the harness as a system (Fowler: "tooling that helps
   configure, sync, and reason about them as a system")

### Gap F: Memory is a guide but never a sensor

`KODR_MEMORY.md` is loaded into the system prompt (guide), but the harness
never writes back to it. When a run fails in a distinctive way, or when the
user corrects the model's approach, that learning isn't captured. The
"steering loop" concept says: when an issue recurs, improve controls. Kodr
has no mechanism to improve its own guides based on observed failures.

### Gap G: No harness coverage reporting

There is no way to answer "which controls ran on this run?" The summary.json
records `tested`, `healed`, `inspectionPlan`, and `contextPacking`, but
there's no unified view like: "This run used: repomap (computational guide),
AGENTS.md (inferential guide), LSP pyright (computational guide+sensor),
npm test (computational sensor), healing loop (inferential sensor, 2 turns)."

### Gap H: No continuous/watch-mode sensors

NEXT.md phase 106 describes this ("Free-Token Background Loops"), but the
gap is real today. Fowler describes "continuous drift and health sensors" —
things that run outside the change lifecycle. Kodr has no file-watcher that
re-runs sensors on change. This is acknowledged as future work and correctly
sequenced late, but the harness architecture should anticipate it.


## 3. Proposed Changes

### Phase 101-A: Harness Module + Opinionated Defaults

This is a single phase that reorganises existing code through the harness
lens and flips defaults. It does NOT add new features — it makes existing
features work together as a system.

#### 3.1 New module: `src/harness.mjs`

A thin orchestration layer that makes the harness loop explicit. Not a
rewrite — it imports existing modules and sequences them.

```
// Conceptual shape, not literal code:
export async function runHarness(cwd, options) {
  // 1. GUIDES: Assemble feedforward context
  const inspection = await runGuides(cwd, options);
  
  // 2. AGENT: Model generates proposal (caller handles this)
  // returns { proposal, completion }
  
  // 3. SENSORS: Post-proposal checks
  //    a. Structural validation (json-extractor, safe-writes)
  //    b. Apply writes
  //    c. Post-write inspection (re-run LSP on changed files)  
  //    d. Verification (test command)
  //    e. Healing loop if needed
  return sensorResults;
}

export function classifyControls(runSummary) {
  // Returns a structured report of which controls ran
  // and what they found, for summary.json
}
```

The key insight: `runGuides()` and `runSensors()` are named after Fowler's
taxonomy. Each returns a structured manifest of what ran and what it found.
This manifest becomes the `harness` field in summary.json.

#### 3.2 Default flips (opinionated defaults)

These are the concrete config changes that make kodr opinionated:

| Option | Current default | New default | Rationale |
|---|---|---|---|
| `inspectContext` | `'auto'` | `true` | Already auto-resolves to true in most cases; make it explicit |
| `lsp` | `false` | `'auto'` | New tri-state: `false` / `true` / `'auto'`. Auto means: discover available LSP servers, use them if found, skip silently if not. |
| `heal` | `'auto'` | `'auto'` (no change) | Already opinionated when --yes + --test |

The `lsp: 'auto'` change is the most impactful. It means:
1. On every run, `discoverInspectors()` probes for LSP server binaries
2. If found, LSP enrichment runs during context assembly (guide)
3. After writes are applied, LSP diagnostics run on changed files (sensor)
4. If no LSP servers are found, behaviour is identical to today

This is safe because `discoverInspectors()` already exists, `onFailure: 'skip'`
is already the default for all registry entries, and the LSP client has
timeouts on every operation.

#### 3.3 Post-write diagnostic sensor

New function in `src/harness.mjs` or `src/post-write-sensor.mjs`:

```
export async function inspectChangedFiles(cwd, writes, options) {
  // 1. Filter writes to inspectable languages
  // 2. If LSP is available, run enrichFile on each changed file
  // 3. Collect diagnostics (errors only, not warnings)
  // 4. Return structured diagnostic report
  return {
    files: [{ path, diagnostics: [{ line, message, severity }] }],
    errorCount: N,
    warningCount: N,
  };
}
```

This sensor runs AFTER writes are applied but BEFORE the test command.
If it finds errors, they are:
1. Included in the healing prompt (so the model sees "your write to
   src/foo.mjs has a type error on line 12" before seeing test failures)
2. Recorded in the run artifacts as `diagnostics.json`

This is a lightweight version of "shift feedback left" — catching type
errors in milliseconds rather than waiting for the test suite.

#### 3.4 LLM-optimised diagnostic rendering

New function in `src/harness.mjs` or existing `healing.mjs`:

```
export function renderDiagnosticsForModel(diagnosticReport) {
  // "3 errors in 2 files after your changes:
  //   src/foo.mjs:12 — Cannot find name 'bar'. Did you mean 'baz'?
  //   src/foo.mjs:45 — Type 'string' is not assignable to type 'number'
  //   src/utils.mjs:8 — Module '"./missing"' not found
  // Fix these before running tests."
}
```

This is Fowler's "positive kind of prompt injection" — diagnostic messages
that include instructions for self-correction. The renderer should:
- Group by file
- Include line numbers and the exact LSP message
- Use imperative language ("Fix these", "This import is unresolved")
- Omit warnings unless error count is zero

The healing loop's `renderLoopRepairPrompt` should include this output
alongside the test results.

#### 3.5 Harness manifest in summary.json

Every run summary gets a new `harness` field:

```json
{
  "harness": {
    "guides": [
      { "name": "repomap", "type": "computational", "symbolCount": 142 },
      { "name": "agents-md", "type": "inferential", "chars": 2400 },
      { "name": "lsp-pyright", "type": "computational", "filesEnriched": 12, "diagnosticsFound": 0 },
      { "name": "memory-project", "type": "inferential", "chars": 800 }
    ],
    "sensors": [
      { "name": "json-extraction", "type": "computational", "ok": true },
      { "name": "safe-writes", "type": "computational", "pathViolations": 0 },
      { "name": "post-write-diagnostics", "type": "computational", "errors": 2, "warnings": 5 },
      { "name": "verification", "type": "computational", "command": "npm test", "ok": false },
      { "name": "healing-loop", "type": "both", "turns": 2, "healed": true }
    ],
    "coverage": {
      "computationalGuides": 2,
      "inferentialGuides": 3,
      "computationalSensors": 4,
      "inferentialSensors": 1,
      "totalControls": 10
    }
  }
}
```

This is the "harness coverage reporting" answer to Gap G. It makes the
invisible visible: which controls ran, what they found, and how much of
the harness was active.


## 4. What "Opinionated Defaults" Means Concretely

After this phase, a fresh `kodr init` project with no flags gets:

1. **Repomap inspection: ON** (already effectively true via auto)
2. **LSP enrichment: AUTO** — if typescript-language-server/pyright/gopls is
   on PATH, it runs. No flag needed. If not found, silent skip.
3. **Post-write diagnostics: ON** when LSP is available. After every apply,
   changed files are re-inspected. Errors are included in healing prompts.
4. **Healing: AUTO** (unchanged, but now with better diagnostic input)
5. **Memory feedback: visible** — summary.json shows exactly what guides and
   sensors ran, so the user can see what their harness looks like.
6. **Harness manifest: always present** in summary.json

The user can still `--no-lsp` or `--no-inspect-context` to opt out. But the
default posture is: every available computational control runs. Inferential
controls (reviewer, skills) remain opt-in because they cost model tokens.


## 5. What NOT To Do

- **Don't create `src/harness/` directory yet.** The codebase is flat ESM
  modules. Adding a subdirectory for one module is premature. If a second
  and third harness module emerge later, refactor then.
- **Don't add runtime dependencies.** LSP and inspector code already exists.
  The proposal uses only existing primitives.
- **Don't merge this with phase 100 (Brownfield Eval).** The eval suite
  measures outcomes; the harness improves process. They are complementary
  but independent. Eval should still come first so harness improvements
  have a scoreboard.
- **Don't auto-write to KODR_MEMORY.md.** The steering loop that feeds
  failures back into guides is valuable but risky (model output is
  untrusted). Leave this as a future phase that requires human approval
  for memory writes.
- **Don't add inferential sensors by default.** The reviewer subagent is
  powerful but expensive. Computational sensors should be the opinionated
  default; inferential sensors should be opt-in.


## 6. Implementation Sequence

This proposal fits as a single phase (101-A, or could be 100.5 between
the eval suite and edit-format work). If it needs splitting:

**Step 1: Harness manifest (low risk)**
Add the `harness` field to summary.json by classifying existing controls.
No behaviour change. Pure instrumentation.

**Step 2: LSP auto-discovery default (medium risk)**
Change `lsp` default from `false` to `'auto'`. Add the tri-state handling
in `parseArgs` and `inspectWithRegistry`. Test that runs with no LSP servers
available are identical to before.

**Step 3: Post-write diagnostic sensor (medium risk)**
Add `inspectChangedFiles` and wire it between apply and verify in the
`runPrompt` flow. Test with a deliberately broken write.

**Step 4: Diagnostic rendering in healing prompts (low risk)**
Add `renderDiagnosticsForModel` and include its output in
`renderLoopRepairPrompt`. Test that healing prompts include diagnostic
context.


## 7. Mapping to Fowler's Regulation Categories

How kodr's harness maps to the three regulation categories:

**Maintainability harness** (strongest today):
- Repomap + LSP symbols → structural awareness (guide)
- Safe-writes path jailing → prevents sloppy file placement (sensor)
- Healing loop wrong-path detection → forces repairs to target the right file
- Post-write diagnostics (proposed) → catches type errors immediately

**Architecture fitness harness** (weak today):
- AGENTS.md can encode architecture rules (guide, inferential)
- Command hooks could run ArchUnit-style tests (sensor, computational)
- Missing: no built-in fitness function runner, no module boundary checks
- The repomap import graph could power a "no circular deps" sensor later

**Behaviour harness** (strongest today):
- Verification runner → test suite as primary behaviour sensor
- Healing loop → self-correction when behaviour is wrong
- Eval suite → offline measurement of behavioural correctness
- Missing: mutation testing, approved fixtures pattern

Kodr's strength is in the behaviour category because it was built around
test-driven verification. The maintainability category is where the most
low-hanging fruit lives (LSP diagnostics, post-write checks). Architecture
fitness is naturally weaker for a tool that works with arbitrary codebases,
but the hook system provides the extension point.


## 8. Connection to NEXT.md Phases

This proposal strengthens every subsequent phase in NEXT.md:

- **Phase 100 (Brownfield Eval):** The harness manifest provides richer
  scoring dimensions. An eval case can assert not just "did the edit work"
  but "did the harness catch the type error before the test suite."
- **Phase 101 (Edit-Format Reliability):** Post-write diagnostics give a
  fast signal for whether a format (search/replace vs full-file vs diff)
  produces parseable code, separate from whether it passes tests.
- **Phase 102 (Repair Pressure):** The diagnostic renderer directly feeds
  the "verification-delta tracking" that NEXT.md calls for.
- **Phase 105 (Run Forensics):** The harness manifest IS the forensic
  data structure. `kodr why` renders it as "here's what your harness
  caught and what it missed."
- **Phase 106 (Background Loops):** The post-write sensor is exactly the
  fast check that a watch-mode loop would run before committing to the
  full test suite.


## 9. Test Plan

All tests use `node:test` with no dependencies, consistent with kodr's
existing test approach.

1. **Harness manifest generation:** Unit test that given a mock run state
   (inspection result, test result, healing result), `classifyControls()`
   returns the expected manifest shape.
2. **LSP auto-discovery:** Unit test that `lsp: 'auto'` calls
   `discoverInspectors` and uses results. Mock the binary probe.
3. **Post-write diagnostic sensor:** Integration test with a fixture file
   containing a known type error. Verify `inspectChangedFiles` returns the
   expected diagnostic.
4. **Diagnostic rendering:** Snapshot test that `renderDiagnosticsForModel`
   produces the expected prompt-friendly output for a sample diagnostic
   report.
5. **Default flip:** Verify that `parseArgs([])` produces `lsp: 'auto'`
   and `inspectContext: true`.
6. **Backward compatibility:** Verify that `--no-lsp` still produces
   `lsp: false` and `--lsp` still produces `lsp: true`.
