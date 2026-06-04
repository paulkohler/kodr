# Phase 83: Compact Subagent Handoffs And Verification

The first all-OpenRouter subagent example showed that isolated conversations
were not enough by themselves. A tiny three-file task used 35,005 tokens, with
more than half spent in the reviewer. The reviewer received the full plan and
proposal in both its system and user messages, reread the generated files, and
ran the requested test command itself.

That run also failed for the wrong reason. The implementation and native Node
tests were correct, but the command was `npm test` and the generated workspace
had no `package.json`. The reviewer reported the command failure while Kodr's
top-level summary still said `tested: false`, because subagent orchestration had
bypassed the normal install and verification pipeline.

Phase 83 makes the handoffs explicit and smaller:

- the implementer receives the plan once in its user message;
- Kodr applies writes, installs dependencies when requested, and runs
  verification before review;
- the reviewer receives a compact write manifest and verification evidence
  instead of complete proposed file contents;
- reviewer tools are read-only and intended for targeted inspection;
- install and test results are recorded in the same top-level artifacts used by
  other run modes.

The verification runner also handles a narrow generated-project case. When the
user requests an npm verification command, the workspace has native Node tests,
and there is no `package.json`, Kodr records the requested command and resolves
it to `node --test`. This avoids both a false failure and npm climbing into a
parent project.

The lesson is that subagents should divide judgment, not duplicate deterministic
work. Planning and review benefit from separate model contexts. Applying files,
installing packages, and running tests belong to the harness.
