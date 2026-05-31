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

test('POST /users creates a user', async () => {
	const user = await createUser('test1@example.com', 'Test User 1');
	assert.ok(user.id);
	assert.equal(user.email, 'test1@example.com');
	assert.equal(user.display_name, 'Test User 1');
	assert.ok(user.created_at);
	assert.ok(user.updated_at);
});

test('POST /users returns 400 for missing fields', async () => {
	const { status, data } = await fetch('/users', {
		method: 'POST',
		body: { email: 'test@example.com' },
	});
	assert.equal(status, 400);
	assert.ok(data.error);
});

test('POST /users returns 400 for invalid email', async () => {
	const { status, data } = await fetch('/users', {
		method: 'POST',
		body: { email: 'not-an-email', display_name: 'Test' },
	});
	assert.equal(status, 400);
	assert.ok(data.error);
});

test('POST /users returns 409 for duplicate email', async () => {
	await createUser('dup@example.com', 'Dup User');
	const { status } = await fetch('/users', {
		method: 'POST',
		body: { email: 'dup@example.com', display_name: 'Dup User 2' },
	});
	assert.equal(status, 409);
});

test('GET /users/:id returns a user', async () => {
	const user = await createUser('getuser@example.com', 'Get User');
	const { status, data } = await fetch(`/users/${user.id}`);
	assert.equal(status, 200);
	assert.equal(data.id, user.id);
	assert.equal(data.email, 'getuser@example.com');
	assert.equal(data.theme, 'light');
	assert.equal(data.notifications_enabled, true);
});

test('GET /users/:id returns 404 for non-existent user', async () => {
	const { status } = await fetch('/users/999999');
	assert.equal(status, 404);
});

test('PATCH /users/:id/settings updates settings', async () => {
	const user = await createUser('settings@example.com', 'Settings User');
	const { status, data } = await fetch(`/users/${user.id}/settings`, {
		method: 'PATCH',
		body: { theme: 'dark', notifications_enabled: false },
	});
	assert.equal(status, 200);
	assert.equal(data.theme, 'dark');
	assert.equal(data.notifications_enabled, false);
});

test('PATCH /users/:id/settings returns 404 for non-existent user', async () => {
	const { status } = await fetch('/users/999999/settings', {
		method: 'PATCH',
		body: { theme: 'dark' },
	});
	assert.equal(status, 404);
});

test('PATCH /users/:id/settings returns 400 for no fields', async () => {
	const user = await createUser('nosettings@example.com', 'No Settings User');
	const { status } = await fetch(`/users/${user.id}/settings`, {
		method: 'PATCH',
		body: {},
	});
	assert.equal(status, 400);
});
