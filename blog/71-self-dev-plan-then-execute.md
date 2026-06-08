# Phase 71: Self-Dev Plan Then Execute

Phase 71 was an acceptance test for the inspection and scratchpad arc. The goal
was not to hand-edit Kodr, but to ask Kodr to inspect itself with a local model,
write a plan, carry that plan into a later turn, and produce a real multi-file
patch.

The first finding was important: local LM Studio requests that included both
native tools and strict structured output did not reliably call tools. Qwen and
Nemotron both returned ordinary proposal JSON while claiming they had inspected
files. The raw request did include the tool schemas, so the issue was not the
registry. Removing `response_format` for local tool-call requests fixed the
probe: Qwen called `list_files`, consumed the tool result, and then returned the
normal Kodr envelope.

Kodr now keeps strict response formats for remote providers and for local
proposal turns without tools, but omits them for local native-tool loops. That is
a pragmatic compatibility choice for small local OpenAI-compatible servers.

The successful acceptance artifact is split across two local-model runs:

- `.kodr-phase71-plan-qwen` called `inspect_symbols` and produced a plan for
  adding `index.totalReferences`.
- `.kodr-phase71-execute-qwen-2` injected the prior model response as scratchpad
  context, called `read_file` for the source and test file, and produced a
  two-file dry-run patch.

This also exposed a second local-model failure: the planning response contained
a useful scratchpad, but it was invalid JSON because multiline markdown was
embedded directly inside a JSON string. Kodr did not extract it into
`scratchpad.md`, so the follow-up run used the recorded `response.md` as the
prior scratchpad. The artifact still preserves model provenance, but the failure
shows why small models need more forgiving scratchpad recovery or stronger
envelope repair in future work.

The generated patch was intentionally left as a dry-run artifact. For this
phase, the product change was the harness compatibility fix; the self-dev edit
itself is evidence that the plan-then-execute flow can now produce a concrete
multi-file patch without frontier-model intervention.
