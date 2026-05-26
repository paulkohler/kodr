import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TodoStore } from '../src/store.mjs';

test('add and list', async (t) => {
	const file = await todoFile(t);
	const todo = await TodoStore.add(file, 'Buy milk');
	const list = await TodoStore.list(file);

	assert.deepEqual(todo, { done: false, id: 1, text: 'Buy milk' });
	assert.deepEqual(list, [{ done: false, id: 1, text: 'Buy milk' }]);
});

test('done and delete', async (t) => {
	const file = await todoFile(t);
	await TodoStore.add(file, 'Task A');
	const completed = await TodoStore.done(file, '1');
	const listAfterDone = await TodoStore.list(file);

	assert.equal(completed.done, true);
	assert.equal(listAfterDone[0].done, true);

	const deleted = await TodoStore.delete(file, '1');
	const finalList = await TodoStore.list(file);

	assert.equal(deleted.text, 'Task A');
	assert.deepEqual(finalList, []);
});

async function todoFile(t) {
	const dir = await mkdtemp(join(tmpdir(), 'todo-cli-'));
	t.after(() => rm(dir, { force: true, recursive: true }));
	return join(dir, 'todos.json');
}
