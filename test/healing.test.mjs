import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { oneShotHeal } from '../src/healing.mjs';
import { runVerification } from '../src/verification-runner.mjs';

describe('one-shot healing', () => {
	it('dry-runs a repair by default', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await oneShotHeal(cwd, failed, repairText('bad.mjs'), {
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, false);
		assert.equal(result.writes.applied, false);
		assert.equal(result.verification, null);
		assert.equal(
			await readFile(join(cwd, 'bad.mjs'), 'utf8'),
			'export const = ;\n',
		);
		assert.match(result.repairPrompt, /previous verification failed/u);
	});

	it('repairs a failing write with explicit apply', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-heal-apply-'));
		await writeFile(join(cwd, 'bad.mjs'), 'export const = ;\n', 'utf8');
		const failed = await runVerification(cwd, 'node --check bad.mjs', {
			timeoutMs: 1000,
		});

		const result = await oneShotHeal(cwd, failed, repairText('bad.mjs'), {
			apply: true,
			testCommand: 'node --check bad.mjs',
			timeoutMs: 1000,
		});

		assert.equal(result.healed, true);
		assert.equal(result.writes.applied, true);
		assert.match(result.repairPrompt, /previous verification failed/u);
	});

	it('does not start repair when verification already passed', async () => {
		const result = await oneShotHeal(
			'/tmp',
			{
				ok: true,
			},
			'{}',
			{
				testCommand: 'node --test',
			},
		);

		assert.equal(result.healed, false);
		assert.equal(result.reason, 'Verification already passed.');
	});
});

function repairText(path) {
	return JSON.stringify({
		files: [
			{
				content: 'export const value = 1;\n',
				path,
			},
		],
	});
}
