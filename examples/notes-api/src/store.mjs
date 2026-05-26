import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class NoteStore {
	constructor(path) {
		this.path = resolve(path);
	}

	async list() {
		return this.read();
	}

	async create(input) {
		const notes = await this.read();
		const now = new Date().toISOString();
		const note = {
			body: input.body,
			createdAt: now,
			id: nextId(notes),
			title: input.title,
			updatedAt: now,
		};
		notes.push(note);
		await this.write(notes);
		return note;
	}

	async get(id) {
		const notes = await this.read();
		return notes.find((note) => note.id === id) || null;
	}

	async update(id, input) {
		const notes = await this.read();
		const note = notes.find((item) => item.id === id);
		if (!note) {
			return null;
		}

		if (Object.hasOwn(input, 'title')) {
			note.title = input.title;
		}
		if (Object.hasOwn(input, 'body')) {
			note.body = input.body;
		}
		note.updatedAt = new Date().toISOString();
		await this.write(notes);
		return note;
	}

	async delete(id) {
		const notes = await this.read();
		const index = notes.findIndex((note) => note.id === id);
		if (index === -1) {
			return null;
		}

		const [deleted] = notes.splice(index, 1);
		await this.write(notes);
		return deleted;
	}

	async read() {
		try {
			const parsed = JSON.parse(await readFile(this.path, 'utf8'));
			if (!Array.isArray(parsed)) {
				throw new Error('Notes file must contain a JSON array');
			}
			return parsed;
		} catch (error) {
			if (error.code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	}

	async write(notes) {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, `${JSON.stringify(notes, null, 2)}\n`, 'utf8');
	}
}

function nextId(notes) {
	return String(Math.max(0, ...notes.map((note) => Number(note.id) || 0)) + 1);
}
