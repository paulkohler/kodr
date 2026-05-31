import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db.js';
import { fetch } from './utils.js';

const BASE_URL =
	process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

async function createUser(email, displayName) {
	const { data } = await fetch('/users', {
		method: 'POST',
		body: { email, display_name: displayName },
	});
	return data;
}

async function createDocument(ownerId, title, body, status) {
	const { data } = await fetch('/documents', {
		method: 'POST',
		body: { owner_id: ownerId, title, body, status },
	});
	return data;
}

test('POST /documents creates a document', async () => {
	const user = await createUser('docowner@example.com', 'Doc Owner');
	const doc = await createDocument(user.id, 'Test Document', 'Hello world');
	assert.ok(doc.id);
	assert.equal(doc.owner_id, user.id);
	assert.equal(doc.title, 'Test Document');
	assert.equal(doc.body, 'Hello world');
	assert.equal(doc.status, 'draft');
});

test('POST /documents returns 400 for missing fields', async () => {
	const { status } = await fetch('/documents', {
		method: 'POST',
		body: { owner_id: 1 },
	});
	assert.equal(status, 400);
});

test('POST /documents returns 400 for invalid status', async () => {
	const user = await createUser('badstatus@example.com', 'Bad Status User');
	const { status } = await fetch('/documents', {
		method: 'POST',
		body: { owner_id: user.id, title: 'Test', status: 'invalid' },
	});
	assert.equal(status, 400);
});

test('GET /documents lists documents', async () => {
	const user = await createUser('listdocs@example.com', 'List Docs User');
	await createDocument(user.id, 'Doc 1', 'Body 1');
	await createDocument(user.id, 'Doc 2', 'Body 2');

	const { status, data } = await fetch('/documents');
	assert.equal(status, 200);
	assert.ok(Array.isArray(data));
	assert.ok(data.length >= 2);
});

test('GET /documents filters by owner_id', async () => {
	const user = await createUser('filterowner@example.com', 'Filter Owner');
	await createDocument(user.id, 'Owned Doc', 'Body');

	const { status, data } = await fetch('/documents?owner_id=' + user.id);
	assert.equal(status, 200);
	assert.ok(data.every((d) => d.owner_id === user.id));
});

test('GET /documents/:id returns a document', async () => {
	const user = await createUser('getdoc@example.com', 'Get Doc User');
	const doc = await createDocument(user.id, 'Get Doc', 'Get Body');

	const { status, data } = await fetch(`/documents/${doc.id}`);
	assert.equal(status, 200);
	assert.equal(data.id, doc.id);
	assert.equal(data.title, 'Get Doc');
	assert.ok(Array.isArray(data.tags));
});

test('GET /documents/:id returns 404 for non-existent document', async () => {
	const { status } = await fetch('/documents/999999');
	assert.equal(status, 404);
});

test('PATCH /documents/:id updates a document', async () => {
	const user = await createUser('updatedoc@example.com', 'Update Doc User');
	const doc = await createDocument(user.id, 'Old Title', 'Old Body');

	const { status, data } = await fetch(`/documents/${doc.id}`, {
		method: 'PATCH',
		body: { title: 'New Title', body: 'New Body', status: 'published' },
	});
	assert.equal(status, 200);
	assert.equal(data.title, 'New Title');
	assert.equal(data.body, 'New Body');
	assert.equal(data.status, 'published');
});

test('PATCH /documents/:id returns 404 for non-existent document', async () => {
	const { status } = await fetch('/documents/999999', {
		method: 'PATCH',
		body: { title: 'New Title' },
	});
	assert.equal(status, 404);
});

test('DELETE /documents/:id deletes a document', async () => {
	const user = await createUser('deletedoc@example.com', 'Delete Doc User');
	const doc = await createDocument(user.id, 'To Delete', 'Body');

	const { status } = await fetch(`/documents/${doc.id}`, {
		method: 'DELETE',
	});
	assert.equal(status, 204);

	// Verify it's gone
	const { status: get } = await fetch(`/documents/${doc.id}`);
	assert.equal(get, 404);
});

test('DELETE /documents/:id returns 404 for non-existent document', async () => {
	const { status } = await fetch('/documents/999999', {
		method: 'DELETE',
	});
	assert.equal(status, 404);
});

test('POST /documents/:id/versions creates a version', async () => {
	const user = await createUser('versiondoc@example.com', 'Version Doc User');
	const doc = await createDocument(user.id, 'Version Doc', 'Version 1');

	const { status, data } = await fetch(`/documents/${doc.id}/versions`, {
		method: 'POST',
		body: { title: 'Version Doc', body: 'Version 2' },
	});
	assert.equal(status, 201);
	assert.equal(data.version_number, 2);
	assert.equal(data.body, 'Version 2');
});

test('GET /documents/:id/versions returns versions', async () => {
	const user = await createUser('getversions@example.com', 'Get Versions User');
	const doc = await createDocument(user.id, 'Versions Doc', 'V1');
	await fetch(`/documents/${doc.id}/versions`, {
		method: 'POST',
		body: { body: 'V2' },
	});

	const { status, data } = await fetch(`/documents/${doc.id}/versions`);
	assert.equal(status, 200);
	assert.ok(Array.isArray(data));
	assert.equal(data.length, 2);
	assert.equal(data[0].version_number, 1);
	assert.equal(data[1].version_number, 2);
});

test('POST /documents/:id/tags adds a tag', async () => {
	const user = await createUser('tagdoc@example.com', 'Tag Doc User');
	const doc = await createDocument(user.id, 'Tag Doc', 'Body');

	const { status, data } = await fetch(`/documents/${doc.id}/tags`, {
		method: 'POST',
		body: { tag: 'important' },
	});
	assert.equal(status, 201);
	assert.equal(data.tag, 'important');
});

test('POST /documents/:id/tags returns 409 for duplicate tag', async () => {
	const user = await createUser('duptag@example.com', 'Dup Tag User');
	const doc = await createDocument(user.id, 'Dup Tag Doc', 'Body');
	await fetch(`/documents/${doc.id}/tags`, {
		method: 'POST',
		body: { tag: 'important' },
	});

	const { status } = await fetch(`/documents/${doc.id}/tags`, {
		method: 'POST',
		body: { tag: 'important' },
	});
	assert.equal(status, 409);
});

test('DELETE /documents/:id/tags/:tag removes a tag', async () => {
	const user = await createUser('removetag@example.com', 'Remove Tag User');
	const doc = await createDocument(user.id, 'Remove Tag Doc', 'Body');
	await fetch(`/documents/${doc.id}/tags`, {
		method: 'POST',
		body: { tag: 'to-remove' },
	});

	const { status } = await fetch(`/documents/${doc.id}/tags/to-remove`, {
		method: 'DELETE',
	});
	assert.equal(status, 204);

	// Verify tag is gone
	const { data } = await fetch(`/documents/${doc.id}`);
	assert.ok(!data.tags.includes('to-remove'));
});

test('DELETE /documents/:id/tags/:tag returns 404 for non-existent tag', async () => {
	const user = await createUser('notag@example.com', 'No Tag User');
	const doc = await createDocument(user.id, 'No Tag Doc', 'Body');

	const { status } = await fetch(`/documents/${doc.id}/tags/nonexistent`, {
		method: 'DELETE',
	});
	assert.equal(status, 404);
});
