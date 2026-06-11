import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
	computeRoutingTable,
	discoverModels,
	loadBenchScores,
	loadRoutingTable,
	renderBenchResults,
	saveBenchScores,
	saveRoutingTable,
} from '../src/bench.mjs';

// ---- helpers ----------------------------------------------------------------

function startModelsServer(models) {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.method === 'GET' && req.url === '/v1/models') {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(
					JSON.stringify({
						object: 'list',
						data: models.map((id) => ({ id, object: 'model' })),
					}),
				);
			} else {
				res.writeHead(404);
				res.end('not found');
			}
		});
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({
				baseUrl: `http://127.0.0.1:${port}/v1`,
				close: () =>
					new Promise((r, j) =>
						server.close((e) => (e ? j(e) : r())),
					),
			});
		});
	});
}

// ---- discoverModels ---------------------------------------------------------

describe('discoverModels', () => {
	it('returns model id strings from a well-formed /v1/models response', async () => {
		const server = await startModelsServer(['model-a', 'model-b']);
		try {
			const ids = await discoverModels(server.baseUrl, 5000);
			assert.deepEqual(ids, ['model-a', 'model-b']);
		} finally {
			await server.close();
		}
	});

	it('returns empty array when data is empty', async () => {
		const server = await startModelsServer([]);
		try {
			const ids = await discoverModels(server.baseUrl, 5000);
			assert.deepEqual(ids, []);
		} finally {
			await server.close();
		}
	});

	it('throws when the server is unreachable', async () => {
		// Use a port that is not listening.
		const server = createServer();
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address();
		await new Promise((r, j) => server.close((e) => (e ? j(e) : r())));

		await assert.rejects(
			() => discoverModels(`http://127.0.0.1:${port}/v1`, 2000),
			(err) => {
				assert.match(err.message, /Failed to reach/);
				return true;
			},
		);
	});

	it('throws on non-200 status', async () => {
		const server = createServer((req, res) => {
			res.writeHead(503);
			res.end('unavailable');
		});
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address();
		const baseUrl = `http://127.0.0.1:${port}/v1`;

		try {
			await assert.rejects(
				() => discoverModels(baseUrl, 2000),
				(err) => {
					assert.match(err.message, /returned 503/);
					return true;
				},
			);
		} finally {
			await new Promise((r, j) =>
				server.close((e) => (e ? j(e) : r())),
			);
		}
	});

	it('throws when response lacks a data array', async () => {
		const server = createServer((req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ models: [] }));
		});
		await new Promise((r) => server.listen(0, '127.0.0.1', r));
		const { port } = server.address();
		const baseUrl = `http://127.0.0.1:${port}/v1`;

		try {
			await assert.rejects(
				() => discoverModels(baseUrl, 2000),
				(err) => {
					assert.match(err.message, /missing data array/);
					return true;
				},
			);
		} finally {
			await new Promise((r, j) =>
				server.close((e) => (e ? j(e) : r())),
			);
		}
	});
});

// ---- saveBenchScores / loadBenchScores round-trip ---------------------------

describe('saveBenchScores / loadBenchScores', () => {
	it('round-trips a Map of score entries', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-bench-scores-'));
		const scores = new Map([
			['model-a', { score: 0.9, passCount: 9, totalCount: 10, timestamp: '2026-01-01T00:00:00.000Z', editFormat: 'patch' }],
			['model-b', { score: 0.5, passCount: 5, totalCount: 10, timestamp: '2026-01-01T00:00:00.000Z', editFormat: 'whole' }],
		]);

		await saveBenchScores(cwd, scores);
		const loaded = await loadBenchScores(cwd);

		assert.equal(loaded.size, 2);
		assert.deepEqual(loaded.get('model-a'), scores.get('model-a'));
		assert.deepEqual(loaded.get('model-b'), scores.get('model-b'));
	});

	it('returns empty Map when file does not exist', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-bench-empty-'));
		const scores = await loadBenchScores(cwd);
		assert.equal(scores.size, 0);
	});

	it('creates .kodr directory if absent', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-bench-mkdir-'));
		const scores = new Map([['model-x', { score: 1.0, passCount: 1, totalCount: 1 }]]);
		await saveBenchScores(cwd, scores);
		const text = await readFile(join(cwd, '.kodr/bench-scores.json'), 'utf8');
		const obj = JSON.parse(text);
		assert.equal(obj['model-x'].score, 1.0);
	});

	it('accepts a plain object in addition to a Map', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-bench-obj-'));
		const scores = { 'model-z': { score: 0.7, passCount: 7, totalCount: 10 } };
		await saveBenchScores(cwd, scores);
		const loaded = await loadBenchScores(cwd);
		assert.equal(loaded.size, 1);
		assert.equal(loaded.get('model-z').score, 0.7);
	});
});

// ---- saveRoutingTable / loadRoutingTable ------------------------------------

describe('saveRoutingTable / loadRoutingTable', () => {
	it('round-trips a routing table', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-routing-'));
		const table = { editModel: 'model-a', editScore: 0.9, cheapModel: 'model-b', cheapScore: 0.5 };
		await saveRoutingTable(cwd, table);
		const loaded = await loadRoutingTable(cwd);
		assert.deepEqual(loaded, table);
	});

	it('returns null when file does not exist', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-routing-missing-'));
		const loaded = await loadRoutingTable(cwd);
		assert.equal(loaded, null);
	});
});

// ---- computeRoutingTable ----------------------------------------------------

describe('computeRoutingTable', () => {
	it('returns null models for empty scores', () => {
		const result = computeRoutingTable(new Map());
		assert.equal(result.editModel, null);
		assert.equal(result.cheapModel, null);
	});

	it('uses the single model for both edit and cheap when only one model', () => {
		const scores = new Map([
			['model-a', { score: 0.8, passCount: 8, totalCount: 10 }],
		]);
		const result = computeRoutingTable(scores);
		assert.equal(result.editModel, 'model-a');
		assert.equal(result.cheapModel, 'model-a');
		assert.equal(result.editScore, 0.8);
	});

	it('selects highest-scoring model as editModel', () => {
		const scores = new Map([
			['model-a', { score: 0.5 }],
			['model-b', { score: 0.9 }],
			['model-c', { score: 0.3 }],
		]);
		const result = computeRoutingTable(scores);
		assert.equal(result.editModel, 'model-b');
		assert.equal(result.editScore, 0.9);
	});

	it('picks a separate cheap model when one exceeds threshold', () => {
		const scores = new Map([
			['strong', { score: 0.95 }],
			['fast', { score: 0.6 }],
			['tiny', { score: 0.1 }],
		]);
		const result = computeRoutingTable(scores, { threshold: 0.3 });
		assert.equal(result.editModel, 'strong');
		// fast passes threshold and is different from strong
		assert.equal(result.cheapModel, 'fast');
		assert.equal(result.cheapScore, 0.6);
	});

	it('falls back cheapModel to editModel when no other model exceeds threshold', () => {
		const scores = new Map([
			['strong', { score: 0.95 }],
			['weak', { score: 0.1 }],
		]);
		const result = computeRoutingTable(scores, { threshold: 0.3 });
		assert.equal(result.editModel, 'strong');
		assert.equal(result.cheapModel, 'strong');
	});

	it('accepts a plain object for scores', () => {
		const scores = { 'model-a': { score: 0.7 }, 'model-b': { score: 0.4 } };
		const result = computeRoutingTable(scores);
		assert.equal(result.editModel, 'model-a');
	});

	it('respects a custom threshold', () => {
		const scores = new Map([
			['strong', { score: 0.9 }],
			['medium', { score: 0.5 }],
		]);
		// threshold of 0.6 means medium (0.5) does NOT qualify
		const result = computeRoutingTable(scores, { threshold: 0.6 });
		assert.equal(result.cheapModel, 'strong');
	});
});

// ---- renderBenchResults -----------------------------------------------------

describe('renderBenchResults', () => {
	it('includes model scores and routing sections', () => {
		const scores = new Map([
			['model-a', { score: 0.9, passCount: 9, totalCount: 10, timestamp: '2026-01-01T00:00:00.000Z' }],
			['model-b', { score: 0.5, passCount: 5, totalCount: 10, timestamp: '2026-02-01T00:00:00.000Z' }],
		]);
		const table = { editModel: 'model-a', editScore: 0.9, cheapModel: 'model-b', cheapScore: 0.5 };
		const output = renderBenchResults(scores, table);

		assert.match(output, /Bench results:/);
		assert.match(output, /model-a.*0\.90.*9\/10/);
		assert.match(output, /model-b.*0\.50.*5\/10/);
		assert.match(output, /Routing:/);
		assert.match(output, /edit.*model-a/);
		assert.match(output, /cheap.*model-b/);
	});

	it('handles empty scores gracefully', () => {
		const output = renderBenchResults(new Map(), null);
		assert.match(output, /no scores recorded/);
	});

	it('shows [same as edit] when cheap and edit are the same model', () => {
		const scores = new Map([['only', { score: 1.0, passCount: 1, totalCount: 1 }]]);
		const table = { editModel: 'only', editScore: 1.0, cheapModel: 'only', cheapScore: 1.0 };
		const output = renderBenchResults(scores, table);
		assert.match(output, /\[same as edit\]/);
	});

	it('omits routing section when routingTable is null', () => {
		const scores = new Map([['model-a', { score: 0.8, passCount: 8, totalCount: 10 }]]);
		const output = renderBenchResults(scores, null);
		assert.equal(output.includes('Routing:'), false);
	});
});
