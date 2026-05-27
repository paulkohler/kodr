import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { installLocal } from '../src/install-local.mjs';

const execFileAsync = promisify(execFile);

describe('local install', () => {
	it('./kodr --version works', async () => {
		const { stdout } = await execFileAsync('./kodr', ['--version'], {
			cwd: process.cwd(),
		});

		assert.equal(stdout.trim(), '0.0.0');
	});

	it('installed temp shim works with --version', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'kodr-bin-'));
		const result = await installLocal(process.cwd(), {
			dir,
			name: 'kodr-test',
		});

		const { stdout } = await execFileAsync(result.path, ['--version']);

		assert.equal(stdout.trim(), '0.0.0');
	});
});
