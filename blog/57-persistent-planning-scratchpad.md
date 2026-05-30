# Phase 57: Persistent Planning Scratchpad

_Making the scratchpad useful across runs, not just within one._

The scratchpad field has existed since the response envelope was designed. Every
model response can include one. Until now, Kodr wrote it to `scratchpad.md`
in the run directory and moved on. The next run had no memory of it.

Phase 57 closes that gap.

---

## What changed

`kodr run` now accepts `--prior-scratchpad <path|last>`. When set, Kodr reads
the file and appends it to the user message before sending:

```
do a task

## Prior scratchpad

{"plan":["step1","step2"],"done":["step1"],"next":"step2"}
```

The `last` alias reads from the most recent run's `scratchpad.md` via the
existing `.kodr/last-run` pointer — no path bookkeeping required.

---

## Why context injection, not a tool call

Tools were considered. The question: should the model call `read_scratchpad()`
explicitly, or should Kodr inject it automatically?

**Context injection wins for the base case.**

- The prior scratchpad is always small and always relevant in a multi-step run.
- A tool adds a round-trip: the model has to decide to call it, wait, then read.
- Small local models (qwen3) can easily forget to call a tool they've never
  been trained to expect; they can't miss context that's already in the message.
- Tool mode is off by default; context injection works in all modes.

A `read_scratchpad(turn?)` tool remains a good idea for reaching back more
than one turn or comparing plans across sessions. That's a future phase.

---

## Small model angle

Qwen3 at ~35B parameters has a finite context window. Two constraints shaped
the implementation:

1. **Truncation at 2000 chars.** A runaway scratchpad (verbose notes, full
   file dumps) would crowd out prompt content and workspace context. Hard cap
   at 2000 chars with a `... (truncated)` suffix.

2. **Skip entirely when empty.** No `## Prior scratchpad\n\n` header appears
   if the file doesn't exist or is blank. The model shouldn't have to process
   an empty section.

3. **User message, not system prompt.** Small models attend more reliably to
   user message content than system prompt additions. The injection goes at
   the bottom of the user turn, after the main prompt.

---

## Structured scratchpad convention

The system prompt now documents a suggested structure:

```json
{
  "plan": ["step 1", "step 2", "step 3"],
  "done": ["step 1"],
  "next": "step 2",
  "notes": "optional free text"
}
```

Kodr doesn't parse or validate this. It's a convention the model can follow
(or ignore) as appropriate. For simple one-shot prompts the scratchpad can
stay as free text. For multi-step tasks where `--prior-scratchpad last` will
be used, structured JSON lets the model quickly find its own plan.

---

## Usage

Chain a two-run self-dev flow:

```sh
# First run: model writes a plan in scratchpad
kodr run --prompt-file phases/58-prompt.md \
  --inspect-context --protect-existing --yes

# Second run: model reads its plan and executes step 2
kodr run --prompt-file phases/58-prompt.md \
  --prior-scratchpad last \
  --inspect-context --protect-existing --yes
```

Or pass a specific file for explicit control:

```sh
kodr run --prompt-file phases/58-prompt.md \
  --prior-scratchpad .kodr/runs/20250530-120000/scratchpad.md
```

---

## What this enables for phases 58–61

The upcoming phases (Inspector Tool Calls, Patch Planning, CLI/TUI Workflow,
Dependency Install) are broader than the self-dev micro-phases. A single prompt
run may not be able to plan and execute everything in one shot — especially on
a local model that can handle ~4K tokens of context comfortably.

With `--prior-scratchpad last`, a two-phase flow becomes natural:

- **Run 1 (plan):** model reads the spec, writes a structured plan with all
  target files and patch locations into scratchpad, produces no changes.
- **Run 2 (execute):** model reads its plan, writes the patches.

This is lighter than full session continuation (which replays the entire
conversation) and cheaper than storing large context. The plan is the only
state that needs to carry over.
