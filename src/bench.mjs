// bench.mjs — zero-dependency, ESM
// Runs eval suites against multiple models and records scores for routing.

import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SCORES_PATH = '.kodr/bench-scores.json';
const ROUTING_PATH = '.kodr/routing.json';

/**
 * Discover models from an OpenAI-compatible /v1/models endpoint.
 * Returns array of model id strings.
 */
export async function discoverModels(baseUrl, timeoutMs = 10000) {
	const url = `${baseUrl}/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let response;
	try {
		response = await fetch(url, {
			method: 'GET',
			headers: { 'content-type': 'application/json' },
			signal: controller.signal,
		});
	} catch (error) {
		throw new Error(`Failed to reach ${url}: ${error.message}`, {
			cause: error,
		});
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		throw new Error(
			`GET ${url} returned ${response.status} ${response.statusText}`,
		);
	}

	const body = await response.json();
	if (!Array.isArray(body?.data)) {
		throw new Error(`Unexpected response from ${url}: missing data array`);
	}

	return body.data.map((m) => m.id).filter(Boolean);
}

/**
 * Load existing bench scores from .kodr/bench-scores.json.
 * Returns Map<modelId, {score, passCount, totalCount, timestamp, editFormat}>
 */
export async function loadBenchScores(cwd) {
	const path = join(cwd, SCORES_PATH);
	try {
		const text = await readFile(path, 'utf8');
		const raw = JSON.parse(text);
		const map = new Map();
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			for (const [modelId, entry] of Object.entries(raw)) {
				map.set(modelId, entry);
			}
		}
		return map;
	} catch {
		return new Map();
	}
}

/**
 * Save bench scores to .kodr/bench-scores.json.
 * Accepts Map<modelId, scoreEntry> or plain object.
 */
export async function saveBenchScores(cwd, scores) {
	const path = join(cwd, SCORES_PATH);
	await mkdir(join(cwd, '.kodr'), { recursive: true });
	const obj = scores instanceof Map ? Object.fromEntries(scores) : scores;
	await writeFile(path, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * Given bench scores, return a routing table:
 * { editModel, cheapModel, editScore, cheapScore }
 * - editModel: highest-scoring model (for edits, planning)
 * - cheapModel: fastest model with score > threshold (for summaries, commit msgs)
 *   Falls back to editModel when no other model exceeds threshold.
 */
export function computeRoutingTable(scores, options = {}) {
	const threshold = options.threshold ?? 0.3;

	const entries =
		scores instanceof Map ? [...scores.entries()] : Object.entries(scores);

	if (entries.length === 0) {
		return {
			editModel: null,
			cheapModel: null,
			editScore: null,
			cheapScore: null,
		};
	}

	// Sort descending by score for deterministic selection.
	const sorted = [...entries].sort((a, b) => {
		const scoreA = typeof a[1]?.score === 'number' ? a[1].score : 0;
		const scoreB = typeof b[1]?.score === 'number' ? b[1].score : 0;
		return scoreB - scoreA;
	});

	const [editModelId, editEntry] = sorted[0];
	const editScore = typeof editEntry?.score === 'number' ? editEntry.score : 0;

	// Cheap model: any model that passes the threshold. Prefer a different model
	// from the edit model if one exists above threshold, otherwise fall back.
	let cheapModelId = editModelId;
	let cheapScore = editScore;

	for (const [modelId, entry] of sorted) {
		const s = typeof entry?.score === 'number' ? entry.score : 0;
		if (modelId !== editModelId && s >= threshold) {
			cheapModelId = modelId;
			cheapScore = s;
			break;
		}
	}

	return {
		editModel: editModelId,
		editScore,
		cheapModel: cheapModelId,
		cheapScore,
	};
}

/**
 * Load routing table from .kodr/routing.json (async).
 * Returns null if not present.
 */
export async function loadRoutingTable(cwd) {
	const path = join(cwd, ROUTING_PATH);
	try {
		const text = await readFile(path, 'utf8');
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Load routing table from .kodr/routing.json (sync).
 * Used by applyModelProfileDefaults which must remain synchronous.
 * Returns null if not present.
 */
export function loadRoutingTableSync(cwd) {
	const path = join(cwd, ROUTING_PATH);
	try {
		const text = readFileSync(path, 'utf8');
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/**
 * Save routing table to .kodr/routing.json.
 */
export async function saveRoutingTable(cwd, table) {
	const path = join(cwd, ROUTING_PATH);
	await mkdir(join(cwd, '.kodr'), { recursive: true });
	await writeFile(path, JSON.stringify(table, null, 2), 'utf8');
}

/**
 * Format bench results for CLI output.
 * Returns a string suitable for writing to stdout.
 */
export function renderBenchResults(scores, routingTable) {
	const entries =
		scores instanceof Map ? [...scores.entries()] : Object.entries(scores);

	const lines = [];
	lines.push('Bench results:');

	if (entries.length === 0) {
		lines.push('  (no scores recorded)');
	} else {
		const sorted = [...entries].sort((a, b) => {
			const scoreA = typeof a[1]?.score === 'number' ? a[1].score : 0;
			const scoreB = typeof b[1]?.score === 'number' ? b[1].score : 0;
			return scoreB - scoreA;
		});

		for (const [modelId, entry] of sorted) {
			const score =
				typeof entry?.score === 'number' ? entry.score.toFixed(2) : '?';
			const pass = entry?.passCount ?? '?';
			const total = entry?.totalCount ?? '?';
			const ts = entry?.timestamp ? ` (${entry.timestamp.slice(0, 10)})` : '';
			lines.push(`  ${modelId}: ${score} (${pass}/${total})${ts}`);
		}
	}

	if (routingTable) {
		lines.push('');
		lines.push('Routing:');
		lines.push(
			`  edit  → ${routingTable.editModel ?? 'none'} (score ${routingTable.editScore?.toFixed(2) ?? '?'})`,
		);
		const sameModel = routingTable.cheapModel === routingTable.editModel;
		lines.push(
			`  cheap → ${routingTable.cheapModel ?? 'none'} (score ${routingTable.cheapScore?.toFixed(2) ?? '?'})${sameModel ? ' [same as edit]' : ''}`,
		);
	}

	return `${lines.join('\n')}\n`;
}
