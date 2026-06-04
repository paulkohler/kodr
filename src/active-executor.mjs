import { join } from 'node:path';
import { writeJson } from './artifacts.mjs';
import { createDockerExecutor } from './docker-executor.mjs';
import { createOpenShellExecutor } from './openshell-executor.mjs';

export function createActiveExecutor(cwd, runDir, options = {}) {
	return (
		createOpenShellExecutor(cwd, runDir, options) ||
		createDockerExecutor(cwd, runDir, options)
	);
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
