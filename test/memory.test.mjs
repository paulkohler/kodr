import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	loadMemory,
	PROJECT_MEMORY_PATH,
	USER_MEMORY_PATH,
} from '../src/memory.mjs';

describe('memory', () => {
	it('loads project and private user memory from separate scopes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-memory-'));
		await writeFile(join(cwd, PROJECT_MEMORY_PATH), 'Project rule.\n', 'utf8');
		await mkdir(join(cwd, '.koder', 'memory'), { recursive: true });
		await writeFile(
			join(cwd, USER_MEMORY_PATH),
			'Private preference.\n',
			'utf8',
		);

		const memory = await loadMemory(cwd);

		assert.equal(memory.project.path, PROJECT_MEMORY_PATH);
		assert.equal(memory.project.content, 'Project rule.\n');
		assert.equal(memory.user.path, USER_MEMORY_PATH);
		assert.equal(memory.user.content, 'Private preference.\n');
	});

	it('omits absent memory scopes', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-no-memory-'));

		const memory = await loadMemory(cwd);

		assert.equal(memory.project, null);
		assert.equal(memory.user, null);
	});

	it('caps loaded memory content', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'koder-memory-cap-'));
		await writeFile(join(cwd, PROJECT_MEMORY_PATH), 'abcdef', 'utf8');

		const memory = await loadMemory(cwd, { maxBytes: 3 });

		assert.equal(memory.project.content, 'abc');
		assert.equal(memory.project.truncated, true);
	});
});
