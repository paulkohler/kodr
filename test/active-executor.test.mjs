import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	createActiveExecutor,
	executorCommandRunner,
	writeExecutorArtifacts,
} from '../src/active-executor.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('active executor', () => {
	// createActiveExecutor is async as of phase 149 (it dynamic-imports the heavy
	// backend only when its flag is set), so these calls are awaited.
	it('selects no executor, Docker, or OpenShell without changing host behavior', async () => {
		assert.equal(
			await createActiveExecutor('/tmp/project', '/tmp/run', {}),
			null,
		);
		assert.equal(executorCommandRunner(null), null);
		assert.equal(
			(
				await createActiveExecutor('/tmp/project', '/tmp/run', {
					dockerSandbox: true,
				})
			).backend,
			'docker',
		);
		assert.equal(
			(
				await createActiveExecutor('/tmp/project', '/tmp/run', {
					openshellSandbox: true,
				})
			).backend,
			'openshell',
		);
	});

	it('writes separate backend artifacts', async () => {
		const runDir = await mkdtemp(join(tmpdir(), 'kodr-active-executor-'));
		const executor = {
			backend: 'openshell',
			metadata() {
				return { backend: 'openshell', enabled: true };
			},
		};

		await writeExecutorArtifacts(runDir, executor);

		assert.deepEqual(
			JSON.parse(await readFile(join(runDir, 'openshell.json'), 'utf8')),
			{ backend: 'openshell', enabled: true },
		);
		assert.deepEqual(
			JSON.parse(await readFile(join(runDir, 'docker.json'), 'utf8')),
			{ enabled: false },
		);
	});
});
