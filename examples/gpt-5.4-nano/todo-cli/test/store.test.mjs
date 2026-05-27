import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TodoStore } from '../src/store.mjs';

describe('TodoStore (JSON persistence)', () => {
	it('starts empty when the file does not exist', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
		const filePath = join(dir, 'todos.json');
		const store = new TodoStore({ filePath });

		const todos = await store.list();
		assert.deepEqual(todos, []);

		await rm(dir, { force: true, recursive: true });
	});

	it('adds, lists, marks done, and deletes', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
		const filePath = join(dir, 'data', 'todos.json');
		const store = new TodoStore({ filePath });

		const a = await store.add('Buy milk');
		const b = await store.add('Read book');
		assert.equal(a.done, false);
		assert.equal(b.done, false);

		const list1 = await store.list();
		assert.equal(list1.length, 2);
		assert.equal(list1[0].text, 'Buy milk');

		await store.setDone(a.id, true);
		const list2 = await store.list();
		assert.equal(list2.find((t) => t.id === a.id).done, true);

		await store.delete(b.id);
		const list3 = await store.list();
		assert.equal(list3.length, 1);
		assert.equal(list3[0].id, a.id);

		const raw = JSON.parse(await readFile(filePath, 'utf8'));
		assert.ok(raw.version === 1);
		assert.ok(Array.isArray(raw.todos));
		assert.equal(raw.todos.length, 1);

		await rm(dir, { force: true, recursive: true });
	});

	it('throws when setting done for a missing id', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'todo-store-'));
		const filePath = join(dir, 'todos.json');
		const store = new TodoStore({ filePath });

		await assert.rejects(() => store.setDone('missing', true), /Todo not found/);
		await rm(dir, { force: true, recursive: true });
	});
});
