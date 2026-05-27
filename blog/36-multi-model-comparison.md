# Phase 36: Multi-Model Comparison

Phase 36 adds `kodr compare`, a command that runs the same prompt against
multiple models and collects the results side-by-side. Phase 34's gpt-5.4-nano
todo-cli run was entirely manual — this phase makes that a first-class harness
operation.

## What changed

`src/compare.mjs` is a new module. Three public exports:

**`parseModelSpec(spec)`** maps a user-supplied string to `{ provider, modelId
}`. The prefix `openrouter:` routes the model through OpenRouter; anything else
is treated as local. Keeping it as a prefix rather than a separate flag avoids
a combinatorial explosion when many models are listed.

**`buildModelOptions(baseOptions, spec, env)`** returns a per-model options
object. For local models it just overrides `model`; for OpenRouter it also
switches `baseUrl`, `apiKey`, and `extraHeaders`. The base options carry all
shared settings (timeout, budget limits, etc.) so each model inherits them
without repetition.

**`runComparison(baseOptions, env, prompt, systemPrompt, modelSpecs, cwd, out)`**
iterates the model list in sequence, calling `runOneModel` (a private
continuation loop, equivalent to `completeWithContinuations` in `app.mjs`) for
each. Errors are caught per-model and recorded in the summary — a failing model
does not abort the rest of the comparison. Artifacts per model:

```
.kodr/runs/<timestamp>/
  comparison.json          ← top-level summary
  qwen_qwen3.6-35b-a3b/
    response.md
    result.json
    raw-response.json
  openai_gpt-5.4-nano/
    response.md
    result.json
    raw-response.json
```

`comparison.json` contains the prompt, timestamp, and a `models` array. Each
entry records `modelSpec`, `provider`, `modelId`, `ok`, `finishReasons`,
`loopBudget`, `responseChars`, `durationMs`, and `error`.

**`kodr compare`** in `app.mjs` loads workspace context (same as `kodr run`)
and calls `runComparison`. The system prompt is the same for all models, making
the comparison fair.

## Design decisions

**No proposal pipeline in compare.** `kodr run` extracts JSON proposals and
applies file writes. `compare` skips that entirely — it collects raw text
responses. The intent is to compare model *behaviour* on a prompt, not to run
a code-generation pipeline twice. Mixing proposal extraction into compare would
cause a model that doesn't speak the JSON envelope to appear as "failed" even
if its response was perfectly sensible.

**Prefix syntax for model specs.** `openrouter:openai/gpt-5.4-nano` is verbose
but unambiguous. Alternatives like a separate `--openrouter-models` flag would
require the user to partition a single list across two flags.

## Live test results

Prompt: `"Write a one-sentence description of what a CLI tool does."`

```
kodr compare \
  -p "Write a one-sentence description of what a CLI tool does." \
  --models "qwen/qwen3.6-35b-a3b,openrouter:openai/gpt-5.4-nano"
```

Both models succeeded in a single turn (`finish_reason: stop`).

**qwen/qwen3.6-35b-a3b (local, 196 chars, 1738 ms)**

> A CLI tool is a command-line interface program that accepts text commands
> from a terminal to perform specific tasks, automate workflows, or interact
> with the operating system and other software.

**openai/gpt-5.4-nano via OpenRouter (272 chars, 1605 ms)**

> `{"status":"OK","messages":[{"level":"info","content":"A one-sentence
> description of what a CLI tool does: It lets you run a program from the
> command line to perform a specific task by parsing user arguments and
> producing output."}],"files":[],"patches":[],"scratchpad":""}`

The gpt-5.4-nano response reveals something worth noting: the workspace system
prompt (loaded from the repo's context packer) still includes the JSON-envelope
instruction. qwen3.6-35b ignored that instruction and answered in plain prose.
gpt-5.4-nano followed it faithfully. Neither is wrong — both gave a correct
one-sentence description — but the difference shows how models respond to the
same prompt differently depending on instruction-following strength. For a
`compare` use-case where you want raw prose answers, a lighter system prompt
would be preferable. That's a future `--no-context` flag, not a phase-36 fix.

## Token usage

Both models reported token counts that look inflated for a one-sentence task
(~21k–23k tokens). This is the workspace context packer including repo files in
the system prompt. The comparison loop passes the full context to every model,
so cost scales with the number of models in the list.
