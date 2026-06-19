# Phase 222: Inter-Stage npm install in the Staged Pipeline

## The symptom

Phase-216/219 dogfooding surfaced a consistent failure pattern: when the model
writes `package.json` in stage 1 and then tries to test the code in stage 2 or
later, the tests fail with `ERR_MODULE_NOT_FOUND`. The imported modules do not
exist on disk because `node_modules` was never populated.

The model's response to this error was predictable: call `run_command(npm
install)`. But in staged mode, `npm install` is blocked by two independent
guards:

1. The **pending-write guard**: if a `package.json` is staged but not yet
   applied, the harness returns an error asking the model to apply writes first.
2. The **TEST_RUNNER_RE guard**: `npm install` matches the pattern used to
   block test commands from running mid-stage.

So the model looped. In one run from Phase 219, 45 of 53 turns were wasted on
blocked `npm install` and `node --test` calls. The sentinel fired 29 times.
Seven stages ran to accommodate a task that should have taken three.

## The root cause

The final-stage `runDependencyInstall` call at the bottom of `runStagedPrompt`
handles dependency installation — but it runs only after all stages complete. If
`package.json` is applied in stage 1 and the task spans multiple stages, every
subsequent stage runs before npm has been invoked. The workspace is inconsistent
and the model is stuck.

## The fix

After each successful stage apply, check whether `package.json` (or
`package-lock.json`) was among the written files. If so, and if `node_modules`
does not yet exist, run `runDependencyInstall` immediately before starting the
next stage:

```js
if (
    options.installDependencies &&
    options.yes &&
    hasDependencyMetadataWrites(writeResult.writes)
) {
    const nodeModulesPath = join(io.cwd, 'node_modules');
    try {
        await access(nodeModulesPath);
        // node_modules already exists — skip
    } catch {
        const interInstall = await runDependencyInstall(
            await verificationCwd(io.cwd, options),
            {
                runner: options.installRunner ?? commandRunner,
                timeoutMs: options.timeoutMs,
            },
        );
        if (!interInstall.ok) {
            writeError = {
                message: `Inter-stage dependency install failed: ${interInstall.command}`,
                name: 'DependencyInstallError',
            };
            stageRecords.push({
                error: writeError,
                interStageInstall: true,
                name: `implement-${stageIndex}-install`,
            });
            break;
        }
        stageRecords.push({
            interStageInstall: true,
            name: `implement-${stageIndex}-install`,
            ok: interInstall.ok,
        });
    }
}
```

This slots in immediately after the existing `stageRecords.push` for the
successful apply. The final-stage install at the bottom of the function is
unchanged — it still handles the case where `package.json` was applied in the
last stage and also handles Cargo.toml installs that the `hasDependencyMetadataWrites`
regex does not catch.

## The `node_modules` gate

The `await access(nodeModulesPath)` check prevents redundant installs when
`node_modules` already exists. The common case where the workspace already has
dependencies installed should pass through silently.

The gate is intentionally coarse — it checks for the directory's existence, not
whether its contents match the `package.json`. This is the same heuristic used
by the `chooseDependencyInstallCommand` fallback in `dependency-installer.mjs`.
Fine-grained staleness detection would require reading `package-lock.json` and
comparing it to `package.json`, which is more work than the harness should do.
If the model updates `package.json` in a workspace that already has
`node_modules`, the inter-stage install is skipped and the final-stage install
handles it.

## Injection for tests

The inter-stage install uses `options.installRunner ?? commandRunner` instead of
just `commandRunner`. The final-stage install uses `commandRunner` directly
(unchanged). This difference is intentional.

`commandRunner` comes from `executorCommandRunner(activeExecutor)` — it's null
when there's no sandbox. With a null runner, `runDependencyInstall` defaults to
`spawnCommand` and runs real npm. In the test suite, that would mean each test
either needs a workspace with a real `package.json` and waits for npm, or uses
a mock.

The `options.installRunner` override makes testing clean: tests inject a
lightweight mock through `handleChannelRequest` (which accepts an options object
that flows straight through to `runStagedPrompt`). The final-stage install
remains untouched and uses real npm in tests that reach it — those tests use
minimal `package.json` content with no dependencies, so npm completes in under
a second.

## The four tests

The new suite in `test/app.test.mjs` uses the `parseArgs` +
`handleChannelRequest` pattern rather than `main()`, because `handleChannelRequest`
accepts an options object that can carry `options.installRunner`.

1. **Stage 1 writes package.json, no node_modules**: the mock installer is
   called, `staged.stages` contains an entry with `interStageInstall: true` and
   `ok: true`.
2. **Stage 1 writes package.json, node_modules already exists**: the mock
   installer is never called, no `interStageInstall` record in `staged.stages`.
3. **Stage 1 writes only non-package.json files**: the mock installer is never
   called, no `interStageInstall` record.
4. **Install failure**: the mock returns `exitCode: 1`, `writeError` is set to
   `DependencyInstallError` with message matching `/Inter-stage dependency
   install failed/`, the `interStageInstall` error record appears in stages, and
   the server records only 2 requests — plan and stage 1 — confirming the loop
   broke before stage 2.

## What this doesn't fix

The inter-stage install only fires when `options.installDependencies` is true
(the `--install` flag). Runs without `--install` still have the same gap. The
assumption is that staged runs that need dependency management will use `--install`.

The `hasDependencyMetadataWrites` regex matches `package.json` and
`package-lock.json` but not Cargo.toml, requirements.txt, or pyproject.toml.
Extending the regex is straightforward but was out of scope for this phase.
