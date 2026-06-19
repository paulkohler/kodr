# Phase 222 — Staged Pipeline: Auto npm install After package.json Apply

## Goal

Phase-216/219 dogfooding: when `package.json` is applied in stage 1, subsequent
stages run before `npm install` has been triggered. The model keeps calling
`run_command(npm install)` which is blocked by the pending-write guard and
`TEST_RUNNER_RE`, and stage-N tests then fail with `ERR_MODULE_NOT_FOUND` because
`node_modules` was never populated.

The final-stage `installDependencies` call at the bottom of `runStagedPrompt`
(~line 2094) runs only after all stages complete. Move dep install into the stage
loop: after each stage's successful apply, if `package.json` was among the applied
writes and `node_modules` does not yet exist in the workspace, run
`npm install --silent` immediately before starting the next stage.

## Changes

### `src/run-pipeline.mjs` — `runStagedPrompt`

After the `clearFiles` call (line ~2083), add an inter-stage dependency install:

```js
// Inter-stage npm install: if this stage applied package.json and node_modules
// does not yet exist, install dependencies before the next stage starts.
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
            { runner: commandRunner, timeoutMs: options.timeoutMs },
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

`access` is already imported (Phase 216). `hasDependencyMetadataWrites`,
`runDependencyInstall`, and `verificationCwd` are already imported and in scope.

The final-stage `runDependencyInstall` call at line ~2094 remains — it handles the
case where package.json was applied in the final stage and no inter-stage install
ran. It also handles Cargo.toml installs (`cargo build`) which this guard does not
attempt.

### Tests

In `test/app.test.mjs`, add a `runStagedPrompt inter-stage npm install` suite:

1. When stage 1 applies `package.json` and `node_modules` is absent, a dependency
   install is triggered between stage 1 and stage 2 (assert `interStageInstall:true`
   in stageRecords and that the installer was called).
2. When `node_modules` already exists after stage 1, no inter-stage install runs.
3. When stage 1 applies only non-package.json files, no inter-stage install runs.
4. Install failure sets `writeError` and breaks the stage loop.

Use the fake-model-server pattern and a mock `runDependencyInstall` injected via
options or the command runner.

## Done criteria

- [x] Inter-stage install fires after stage N when `package.json` applied and `node_modules` absent.
- [x] Skipped when `node_modules` exists.
- [x] Skipped for non-package.json writes.
- [x] Install failure breaks stage loop with `DependencyInstallError`.
- [x] Final-stage install unchanged (still runs at end).
- [x] 4 new tests pass.
- [x] `npm run format && npm run check` clean.
- [x] `process/decisions.jsonl` entry added.
- [x] Blog post exists.
- [x] Roadmap entry marked done.
- [x] Commit made.
