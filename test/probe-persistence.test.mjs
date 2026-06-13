// Tests for probe-persistence.mjs (T3, phase 118).
// All tests use fake servers or in-memory fixtures — no live LM Studio calls.

import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import {
	findProbeEntry,
	loadProbeResults,
	loadProbeResultsSync,
	probeKey,
	resolveToolWritesMode,
	saveProbeResult,
} from '../src/probe-persistence.mjs';

// ---------------------------------------------------------------------------
// probeKey
// ---------------------------------------------------------------------------
describe('probeKey', () => {
	it('produces a composite key from baseUrl and model', () => {
		const key = probeKey('http://localhost:1234/v1', 'qwen/qwen3.6-35b-a3b');
		assert.equal(key, 'http://localhost:1234/v1::qwen/qwen3.6-35b-a3b');
	});
});

// ---------------------------------------------------------------------------
// saveProbeResult / loadProbeResults round-trip
// ---------------------------------------------------------------------------
describe('saveProbeResult / loadProbeResults', () => {
	it('writes and reads back a probe entry', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-persist-'));
		await saveProbeResult(cwd, 'http://localhost:1234/v1', 'my-model', {
			toolSupport: 'native',
			evidenceSnippet: '{"name":"probe_echo"...}',
			structuredOutputMode: 'none',
		});

		const data = await loadProbeResults(cwd);
		assert.ok(data !== null, 'probe.json should exist after save');
		const key = probeKey('http://localhost:1234/v1', 'my-model');
		const entry = data[key];
		assert.ok(entry, 'entry should be present under the composite key');
		assert.equal(entry.toolSupport, 'native');
		assert.equal(entry.baseUrl, 'http://localhost:1234/v1');
		assert.equal(entry.model, 'my-model');
		assert.ok(
			typeof entry.timestamp === 'string',
			'timestamp should be present',
		);
	});

	it('merges subsequent saves (last-write-wins per key)', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-merge-'));
		await saveProbeResult(cwd, 'http://localhost:1234/v1', 'model-a', {
			toolSupport: 'native',
		});
		await saveProbeResult(cwd, 'http://localhost:1234/v1', 'model-b', {
			toolSupport: 'fallback',
		});
		// Overwrite model-a
		await saveProbeResult(cwd, 'http://localhost:1234/v1', 'model-a', {
			toolSupport: 'none',
		});

		const data = await loadProbeResults(cwd);
		const keyA = probeKey('http://localhost:1234/v1', 'model-a');
		const keyB = probeKey('http://localhost:1234/v1', 'model-b');
		assert.equal(
			data[keyA].toolSupport,
			'none',
			'model-a should be overwritten',
		);
		assert.equal(
			data[keyB].toolSupport,
			'fallback',
			'model-b should be unchanged',
		);
	});

	it('loadProbeResults returns null when probe.json does not exist', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-nofile-'));
		const data = await loadProbeResults(cwd);
		assert.equal(data, null);
	});

	it('loadProbeResultsSync returns null when probe.json does not exist', () => {
		// Use a path that doesn't exist
		const data = loadProbeResultsSync('/tmp/__kodr_nonexistent_probe_test__');
		assert.equal(data, null);
	});

	it('loadProbeResultsSync reads probe.json synchronously', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-sync-'));
		await saveProbeResult(cwd, 'http://localhost:1234/v1', 'sync-model', {
			toolSupport: 'fallback',
		});
		const data = loadProbeResultsSync(cwd);
		assert.ok(data !== null);
		const key = probeKey('http://localhost:1234/v1', 'sync-model');
		assert.equal(data[key].toolSupport, 'fallback');
	});
});

// ---------------------------------------------------------------------------
// findProbeEntry
// ---------------------------------------------------------------------------
describe('findProbeEntry', () => {
	it('returns the entry when found', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-find-'));
		await saveProbeResult(cwd, 'http://a/v1', 'model-x', {
			toolSupport: 'native',
		});
		const data = await loadProbeResults(cwd);
		const entry = findProbeEntry(data, 'http://a/v1', 'model-x');
		assert.ok(entry, 'should find the entry');
		assert.equal(entry.toolSupport, 'native');
	});

	it('returns null when not found', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-findnot-'));
		await saveProbeResult(cwd, 'http://a/v1', 'model-x', {
			toolSupport: 'native',
		});
		const data = await loadProbeResults(cwd);
		const entry = findProbeEntry(data, 'http://a/v1', 'model-y');
		assert.equal(entry, null);
	});

	it('returns null for null probeData', () => {
		assert.equal(findProbeEntry(null, 'http://a/v1', 'model-x'), null);
	});
});

// ---------------------------------------------------------------------------
// resolveToolWritesMode (T3: auto-resolution rule)
// ---------------------------------------------------------------------------
describe('resolveToolWritesMode', () => {
	it("'native' profile setting returns 'native' regardless of probe data", () => {
		const mode = resolveToolWritesMode('native', null, 'http://a/v1', 'model');
		assert.equal(mode, 'native');
	});

	it("'envelope' profile setting returns 'envelope' regardless of probe data", () => {
		const mode = resolveToolWritesMode(
			'envelope',
			null,
			'http://a/v1',
			'model',
		);
		assert.equal(mode, 'envelope');
	});

	it("'auto' with no probe data returns 'auto'", () => {
		const mode = resolveToolWritesMode('auto', null, 'http://a/v1', 'model');
		assert.equal(mode, 'auto');
	});

	it("'auto' with probe data showing 'native' resolves to 'native'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-resolve-'));
		await saveProbeResult(cwd, 'http://a/v1', 'model', {
			toolSupport: 'native',
		});
		const data = await loadProbeResults(cwd);
		const mode = resolveToolWritesMode('auto', data, 'http://a/v1', 'model');
		assert.equal(mode, 'native');
	});

	it("'auto' with probe data showing 'fallback' stays 'auto'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-resolve2-'));
		await saveProbeResult(cwd, 'http://a/v1', 'model', {
			toolSupport: 'fallback',
		});
		const data = await loadProbeResults(cwd);
		const mode = resolveToolWritesMode('auto', data, 'http://a/v1', 'model');
		assert.equal(mode, 'auto');
	});

	it("'auto' with probe data showing 'none' stays 'auto'", async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-resolve3-'));
		await saveProbeResult(cwd, 'http://a/v1', 'model', { toolSupport: 'none' });
		const data = await loadProbeResults(cwd);
		const mode = resolveToolWritesMode('auto', data, 'http://a/v1', 'model');
		assert.equal(mode, 'auto');
	});

	it("'auto' resolves 'native' only for the exact (baseUrl, model) pair", async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'kodr-probe-resolve4-'));
		await saveProbeResult(cwd, 'http://a/v1', 'model-x', {
			toolSupport: 'native',
		});
		const data = await loadProbeResults(cwd);
		// Different model — should not resolve to native.
		const mode = resolveToolWritesMode('auto', data, 'http://a/v1', 'model-y');
		assert.equal(mode, 'auto');
	});
});
