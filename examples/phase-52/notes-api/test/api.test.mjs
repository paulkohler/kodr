import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.mjs';
import { NoteStore } from '../src/store.mjs';

describe('notes api', () => {
	it('creates, lists, reads, updates, and deletes notes', async (t) => {
		const fixture = await startFixture(t);

		const created = await fixture.request('/notes', {
			body: {
				body: 'Body text',
				title: 'First note',
			},
			method: 'POST',
		});
		assert.equal(created.status, 201);
		assert.equal(created.body.note.id, '1');

		const listed = await fixture.request('/notes');
		assert.equal(listed.status, 200);
		assert.equal(listed.body.notes.length, 1);

		const read = await fixture.request('/notes/1');
		assert.equal(read.status, 200);
		assert.equal(read.body.note.title, 'First note');

		const updated = await fixture.request('/notes/1', {
			body: { title: 'Updated note' },
			method: 'PATCH',
		});
		assert.equal(updated.status, 200);
		assert.equal(updated.body.note.title, 'Updated note');
		assert.equal(updated.body.note.body, 'Body text');

		const deleted = await fixture.request('/notes/1', { method: 'DELETE' });
		assert.equal(deleted.status, 200);

		const empty = await fixture.request('/notes');
		assert.deepEqual(empty.body.notes, []);
	});

	it('validates json and note fields', async (t) => {
		const fixture = await startFixture(t);

		const invalidJson = await fixture.raw('/notes', {
			body: '{',
			method: 'POST',
		});
		assert.equal(invalidJson.status, 400);
		assert.match(invalidJson.body.error, /Invalid JSON/u);

		const invalidFields = await fixture.request('/notes', {
			body: { body: 'missing title' },
			method: 'POST',
		});
		assert.equal(invalidFields.status, 400);
		assert.match(invalidFields.body.error, /title and body/u);

		const emptyPatch = await fixture.request('/notes/1', {
			body: {},
			method: 'PATCH',
		});
		assert.equal(emptyPatch.status, 400);
	});

	it('returns not found and persists notes to disk', async (t) => {
		const fixture = await startFixture(t);

		const missing = await fixture.request('/notes/nope');
		assert.equal(missing.status, 404);

		await fixture.request('/notes', {
			body: { body: 'Persisted body', title: 'Persisted' },
			method: 'POST',
		});

		const stored = JSON.parse(await readFile(fixture.notesFile, 'utf8'));
		assert.equal(stored[0].title, 'Persisted');
	});

	it('returns 404 for unknown routes', async (t) => {
		const fixture = await startFixture(t);

		const notFound = await fixture.request('/unknown');
		assert.equal(notFound.status, 404);
		assert.equal(notFound.body.error, 'Not found');
	});

	it('uses in-memory store when provided', async (t) => {
		const store = new NoteStore(':memory:');
		const fixture = await startFixture(t, { store });

		const created = await fixture.request('/notes', {
			body: { body: 'Mem body', title: 'Mem note' },
			method: 'POST',
		});
		assert.equal(created.status, 201);

		const listed = await fixture.request('/notes');
		assert.equal(listed.body.notes.length, 1);
		assert.equal(listed.body.notes[0].title, 'Mem note');
	});
});

async function startFixture(t, options = {}) {
	const dir = await mkdtemp(join(tmpdir(), 'notes-api-'));
	const notesFile = join(dir, 'notes.json');
	const app = createApp({ notesFile, ...options });
	const server = createServer(app);
	await listen(server);

	t.after(async () => {
		await close(server);
		await rm(dir, { force: true, recursive: true });
	});

	const baseUrl = serverBaseUrl(server);
	return {
		notesFile,
		raw(path, options = {}) {
			return request(baseUrl, path, options);
		},
		request(path, options = {}) {
			return request(baseUrl, path, {
				...options,
				body:
					options.body === undefined ? undefined : JSON.stringify(options.body),
				headers: {
					'content-type': 'application/json',
					...(options.headers || {}),
				},
			});
		},
	};
}

async function request(baseUrl, path, options = {}) {
	const response = await fetch(`${baseUrl}${path}`, {
		body: options.body,
		headers: options.headers,
		method: options.method || 'GET',
	});
	return {
		body: await response.json(),
		status: response.status,
	};
}

function listen(server) {
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
}

function close(server) {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function serverBaseUrl(server) {
	const address = server.address();
	return `http://${address.address}:${address.port}`;
}
