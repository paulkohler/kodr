// probe-persistence.mjs — read/write .kodr/probe.json
// Keyed by (baseUrl, model) composite key with timestamps.
// Pattern follows bench.mjs routing.json persistence (phase 105).

import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const PROBE_PATH = '.kodr/probe.json';

/**
 * Composite key for a (baseUrl, model) pair.
 */
export function probeKey(baseUrl, model) {
	return `${baseUrl}::${model}`;
}

/**
 * Load probe measurements from .kodr/probe.json (async).
 * Returns null if not present.
 */
export async function loadProbeResults(cwd) {
	const path = join(cwd, PROBE_PATH);
	try {
		const text = await readFile(path, 'utf8');
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Load probe measurements from .kodr/probe.json (sync).
 * Used by applyModelProfileDefaults which must remain synchronous.
 * Returns null if not present.
 */
export function loadProbeResultsSync(cwd) {
	const path = join(cwd, PROBE_PATH);
	try {
		const text = readFileSync(path, 'utf8');
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Save probe measurements to .kodr/probe.json.
 * Merges with existing entries (last-write-wins per key).
 * @param {string} cwd
 * @param {string} baseUrl
 * @param {string} model
 * @param {object} entry  — { toolSupport, evidenceSnippet, timestamp, ... }
 */
export async function saveProbeResult(cwd, baseUrl, model, entry) {
	const path = join(cwd, PROBE_PATH);
	await mkdir(join(cwd, '.kodr'), { recursive: true });

	let existing = {};
	try {
		const text = await readFile(path, 'utf8');
		existing = JSON.parse(text);
	} catch {
		// Start fresh
	}

	const key = probeKey(baseUrl, model);
	existing[key] = {
		...entry,
		baseUrl,
		model,
		timestamp: new Date().toISOString(),
	};
	await writeFile(path, JSON.stringify(existing, null, 2), 'utf8');
}

/**
 * Look up a (baseUrl, model) measurement from probe.json data.
 * @param {object|null} probeData  — parsed probe.json content
 * @param {string} baseUrl
 * @param {string} model
 * @returns {object|null}
 */
export function findProbeEntry(probeData, baseUrl, model) {
	if (!probeData || typeof probeData !== 'object') {
		return null;
	}
	const key = probeKey(baseUrl, model);
	const entry = probeData[key];
	return entry && typeof entry === 'object' ? entry : null;
}

/**
 * Resolve the effective toolWrites mode, incorporating probe.json measurements.
 *
 * Rules (T3):
 *   - 'native' or 'envelope' profile setting → returned as-is (no probe lookup).
 *   - 'auto' → if probe.json records 'native' toolSupport for this (baseUrl, model),
 *               resolve to 'native'; otherwise stay 'auto' (117 behaviour).
 *
 * @param {string} profileToolWrites  — 'native' | 'envelope' | 'auto'
 * @param {object|null} probeData     — parsed probe.json or null
 * @param {string} baseUrl
 * @param {string} model
 * @returns {'native'|'envelope'|'auto'}
 */
export function resolveToolWritesMode(
	profileToolWrites,
	probeData,
	baseUrl,
	model,
) {
	if (profileToolWrites === 'native' || profileToolWrites === 'envelope') {
		return profileToolWrites;
	}
	// 'auto': check probe data
	const entry = findProbeEntry(probeData, baseUrl, model);
	if (entry?.toolSupport === 'native') {
		return 'native';
	}
	return 'auto';
}
