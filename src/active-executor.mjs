import { join } from 'node:path';
import { writeJson } from './artifacts.mjs';

// Lazy backends (phase 149): the heavy sandbox executors (node:child_process +
// the full Docker/OpenShell machinery) are imported only when their flag is set,
// so a bare `run` never loads them. The original precedence — OpenShell wins over
// Docker — is preserved. This makes createActiveExecutor async; both call sites
// (run-pipeline.runPrompt, app.handleChannelRequest) already await it.
export async function createActiveExecutor(cwd, runDir, options = {}) {
	if (options.openshellSandbox) {
		const { createOpenShellExecutor } = await import(
			'./openshell-executor.mjs'
		);
		const executor = createOpenShellExecutor(cwd, runDir, options);
		if (executor) {
			return executor;
		}
	}
	if (options.dockerSandbox) {
		const { createDockerExecutor } = await import('./docker-executor.mjs');
		const executor = createDockerExecutor(cwd, runDir, options);
		if (executor) {
			return executor;
		}
	}
	return null;
}

export function executorCommandRunner(executor) {
	return executor ? executor.run.bind(executor) : null;
}

export async function initializeExecutor(executor, timeoutMs) {
	await executor?.initialize?.(timeoutMs);
}

export async function syncExecutorWorkspace(executor, timeoutMs) {
	await executor?.syncWorkspace?.(timeoutMs);
}

export async function finalizeExecutor(executor, timeoutMs) {
	await executor?.finalize?.(timeoutMs);
}

export async function writeExecutorArtifacts(runDir, executor) {
	const metadata = executor?.metadata?.() || { enabled: false };
	await writeJson(
		join(runDir, 'docker.json'),
		executor?.backend === 'docker' ? metadata : { enabled: false },
	);
	await writeJson(
		join(runDir, 'openshell.json'),
		executor?.backend === 'openshell' ? metadata : { enabled: false },
	);
}
