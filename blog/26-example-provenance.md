# Phase 26: Example Provenance

The CSV expense example exposed a process bug rather than just a code bug. The first generation failed, and treating the result as a manually completed fixture made the example less useful as a Kodr sample.

This phase corrects that. Examples now need provenance: the prompts, run artifacts, verification results, and follow-up slices that produced or repaired the sample. A failed one-shot generation is not the end of the loop. It should either improve the harness or be split into smaller Kodr runs that can be inspected.

The first harness fix from this phase is streaming chat completion support. The CSV parser slice failed over the normal request path, then succeeded after `--stream` was added. That gave us a real Kodr-produced change to the example rather than a hidden manual replacement.

The follow-up repair slices also found another harness limitation. Full-file rewrites are clumsy for tiny fixes: one slice fixed a diagnostic assertion but regressed the escaped-quote fixture, and another fixed syntax while regressing the fixture again. The example was stabilized with a small human correction, but the provenance records that honestly. A later patch-oriented repair mode should make this kind of tiny correction safer.

The CLI also now prints `Run failed` when verification fails, instead of printing `Run ok` for a run whose summary is `ok: false`.
