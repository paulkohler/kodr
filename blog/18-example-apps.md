# Phase 18: Example Apps

This phase started the example-app suite that Kodr can use as small, repeatable harness trials.

The candidate list covers a few project shapes: a CLI todo app, Markdown blog generator, Express notes API, CSV expense analyzer, SQLite habit tracker, local Markdown search app, and React Kanban board. The CLI todo app was the first trial because it is small enough to inspect quickly but still exercises file generation, persistence, argument parsing, and tests.

The first Kodr run produced a valid JSON proposal, but the generated app failed its own tests. The initial failure was useful: the store tried to create the JSON file path as a directory, and the generated tests expected `list()` to return data even though the generated implementation only logged it.

That exposed a Kodr gap too. Generated examples live in subdirectories, but the harness could only run verification from the repository root. Kodr now supports `--test-cwd path`, jails that path inside the workspace, and runs allowlisted verification commands from there.

A second run proved the new subproject verification path worked, then failed on another generated issue: the model used CommonJS `require()` in an ESM test file. The prompt now explicitly forbids CommonJS globals, and Kodr now marks the overall run as failed when verification fails so callers do not have to inspect nested test output to know the generation needs repair.

The final example app is under `examples/todo-cli`. It uses ESM, Node built-ins, JSON persistence, positional CLI commands, and native `node:test` coverage.
