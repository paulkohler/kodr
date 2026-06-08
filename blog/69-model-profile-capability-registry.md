# Phase 69: Model Profile And Capability Registry

Kodr had model defaults scattered across the CLI: the default LM Studio URL, the
default Qwen model, the long local timeout, and separate assumptions about tools
and JSON behavior. That was workable while there was one main local model, but
it became fragile once runs started mixing Qwen, Nemotron, OpenRouter planners,
and model-specific context windows.

Phase 69 adds a small model profile registry. The built-in profiles cover the
default `qwen/qwen3.6-35b-a3b`, `nvidia/nemotron-3-nano-omni`, Ollama wildcard
models, and OpenRouter wildcard models. Projects can add or override profiles in
`.kodr/model-profiles.json`, and users can point `KODR_MODEL_PROFILES` at a
specific JSON file.

Profiles record the model id, provider, base URL, context window, completion
reserve, timeout, native tool-call support, and recommended response-envelope
mode. Kodr now attaches the active profile to run summaries and subagent
orchestration metadata, so a failed run can be inspected with the same model
capability context that shaped it.

Two defaults moved behind the profile layer:

- timeout defaults now come from the active profile unless `--timeout-ms` is set;
- session compaction defaults derive from context window minus completion
  reserve, using a conservative chars-per-token estimate, unless
  `--session-context-chars` is set.

The context packing change is intentionally conservative. Profiles can reduce
the packing cap for small context windows, but Kodr keeps the existing maximum
cap until Phase 61 implements full token-budget-aware assembly. This avoids
turning a profile registry phase into a context-packer rewrite.

The main lesson is that model configuration is harness behavior, not a cosmetic
setting. Local models differ enough that context budget, timeout, tool support,
and output expectations need to be explicit and artifacted.
