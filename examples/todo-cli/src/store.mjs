import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class TodoStore {
	static async add(filePath, text) {
		if (!text.trim()) {
			throw new Error('Todo text is required');
		}

		const data = await this.load(filePath);
		const id = Math.max(0, ...data.map((todo) => todo.id)) + 1;
		const todo = { done: false, id, text };
		data.push(todo);
		await this.save(filePath, data);
		return todo;
	}

	static async list(filePath) {
		return this.load(filePath);
	}

	static async done(filePath, idText) {
		const data = await this.load(filePath);
		const id = parseId(idText);
		const todo = data.find((item) => item.id === id);
		if (!todo) {
			throw new Error(`Todo not found: ${id}`);
		}

		todo.done = true;
		await this.save(filePath, data);
		return todo;
	}

	static async delete(filePath, idText) {
		const data = await this.load(filePath);
		const id = parseId(idText);
		const index = data.findIndex((item) => item.id === id);
		if (index === -1) {
			throw new Error(`Todo not found: ${id}`);
		}

		const [todo] = data.splice(index, 1);
		await this.save(filePath, data);
		return todo;
	}

	static async load(filePath) {
		try {
			const content = await readFile(resolve(filePath), 'utf8');
			const parsed = JSON.parse(content);
			if (!Array.isArray(parsed)) {
				throw new Error('Todo file must contain a JSON array');
			}
			return parsed;
		} catch (error) {
			if (error.code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	}

	static async save(filePath, data) {
		const path = resolve(filePath);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
	}
}

function parseId(text) {
	const id = Number(text);
	if (!Number.isInteger(id) || id < 1) {
		throw new Error(`Invalid todo id: ${text}`);
	}
	return id;
}
