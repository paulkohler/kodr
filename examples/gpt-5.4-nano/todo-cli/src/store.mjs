import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function isObject(value) {
	return value !== null && typeof value === 'object';
}

function normalizeTodos(value) {
	if (!Array.isArray(value)) return [];
	return value
		.filter((t) => isObject(t))
		.map((t) => ({
			id: String(t.id ?? ''),
			text: String(t.text ?? ''),
			done: Boolean(t.done),
		}))
		.filter((t) => t.id && t.text);
}

async function ensureDir(filePath) {
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true });
}

export class TodoStore {
	constructor(options = {}) {
		this.filePath = options.filePath;
		if (!this.filePath) {
			throw new Error('TodoStore requires filePath');
		}
	}

	async _read() {
		try {
			const raw = await readFile(this.filePath, 'utf8');
			const data = JSON.parse(raw);
			if (!isObject(data)) return [];
			return normalizeTodos(data.todos);
		} catch (error) {
			// If missing file, treat as empty.
			if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
			throw error;
		}
	}

	async _write(todos) {
		await ensureDir(this.filePath);
		const payload = {
			version: 1,
			todos,
		};
		await writeFile(this.filePath, JSON.stringify(payload, null, '\t') + '\n', 'utf8');
	}

	async list() {
		return this._read();
	}

	async add(text) {
		const clean = String(text ?? '').trim();
		if (!clean) throw new Error('Todo text must be non-empty');
		const todos = await this._read();
		const todo = {
			id: randomUUID(),
			text: clean,
			done: false,
		};
		todos.push(todo);
		await this._write(todos);
		return todo;
	}

	async setDone(id, done) {
		const todoId = String(id ?? '').trim();
		if (!todoId) throw new Error('id must be non-empty');
		const todos = await this._read();
		let found = false;
		for (const t of todos) {
			if (t.id === todoId) {
				t.done = Boolean(done);
				found = true;
				break;
			}
		}
		if (!found) throw new Error(`Todo not found: ${todoId}`);
		await this._write(todos);
	}

	async delete(id) {
		const todoId = String(id ?? '').trim();
		if (!todoId) throw new Error('id must be non-empty');
		const todos = await this._read();
		const next = todos.filter((t) => t.id !== todoId);
		if (next.length === todos.length) {
			throw new Error(`Todo not found: ${todoId}`);
		}
		await this._write(next);
	}
}
