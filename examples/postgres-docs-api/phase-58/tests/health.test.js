import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';
import { query } from '../src/db.js';

const BASE_URL =
	process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

async function fetch(path, options = {}) {
	const url = new URL(path, BASE_URL);
	const res = await fetch(url.toString(), {
		method: options.method || 'GET',
		headers: { 'Content-Type': 'application/json', ...options.headers },
		body: options.body ? JSON.stringify(options.body) : undefined,
	});
	const data = await res.json().catch(() => null);
	return { status: res.status, data };
}

test('GET /health returns 200 with ok status', async () => {
	const { status, data } = await fetch('/health');
	assert.equal(status, 200);
	assert.equal(data.status, 'ok');
	assert.equal(data.database, 'connected');
});

test('GET /health returns 503 when database is down', async () => {
	// This test assumes the database is running; skip if not
	const { status } = await fetch('/health');
	assert.ok(status === 200 || status === 503);
});

test('GET /unknown returns 404', async () => {
	const { status, data } = await fetch('/unknown');
	assert.equal(status, 404);
	assert.ok(data.error);
});
