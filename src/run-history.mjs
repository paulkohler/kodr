import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

export async function scanRunHistory(cwd, promptId) {
	const runsDir = join(cwd, '.kodr', 'runs');
	let entries;
	try {
		entries = await readdir(runsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const runs = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const runPath = join(runsDir, entry.name);
		let summary;
		try {
			summary = JSON.parse(
				await readFile(join(runPath, 'summary.json'), 'utf8'),
			);
		} catch {
			continue;
		}
		if (summary.promptId !== promptId) continue;

		let evalScore = null;
		try {
			const evalResults = JSON.parse(
				await readFile(join(runPath, 'eval-results.json'), 'utf8'),
			);
			evalScore =
				typeof evalResults.score === 'number' ? evalResults.score : null;
		} catch {
			// no eval results in this run dir
		}

		runs.push({
			runDir: runPath,
			timestamp: summary.timestamp || entry.name,
			model: summary.model || '',
			finishReasons: summary.finishReasons || [],
			ok: summary.ok,
			evalScore,
			tokens: summary.usage?.tokens ?? 0,
		});
	}

	runs.sort((a, b) => a.runDir.localeCompare(b.runDir));
	return runs;
}

// Scan all run dirs and group by sessionId, returning a map from sessionId to
// an array of run entries sorted chronologically. Only runs that have a
// summary.json with a sessionId field are included.
export async function scanSessions(cwd) {
	const runsDir = join(cwd, '.kodr', 'runs');
	let entries;
	try {
		entries = await readdir(runsDir, { withFileTypes: true });
	} catch {
		return new Map();
	}

	const sessions = new Map();

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const runPath = join(runsDir, entry.name);
		let summary;
		try {
			summary = JSON.parse(
				await readFile(join(runPath, 'summary.json'), 'utf8'),
			);
		} catch {
			continue;
		}

		const sessionId = summary.sessionId || basename(runPath);
		if (!sessions.has(sessionId)) {
			sessions.set(sessionId, []);
		}
		sessions.get(sessionId).push({
			runDir: runPath,
			timestamp: summary.timestamp || entry.name,
			model: summary.model || '',
			ok: summary.ok,
			parentRunDir: summary.parentRunDir || null,
			tokens: summary.usage?.tokens ?? 0,
		});
	}

	for (const runs of sessions.values()) {
		// Run dir names are ISO timestamps so lexicographic order = chronological.
		runs.sort((a, b) => a.runDir.localeCompare(b.runDir));
	}

	return sessions;
}

// Load a conversation chain for a session: reads conversation.json from each
// run in the session in order, returning { turns } where each turn has the
// user message and the assistant reply from that run.
export async function loadSessionConversation(cwd, sessionId) {
	const sessions = await scanSessions(cwd);
	const runs = sessions.get(sessionId);
	if (!runs || runs.length === 0) {
		return null;
	}

	const turns = [];
	for (const run of runs) {
		let conversation;
		try {
			conversation = JSON.parse(
				await readFile(join(run.runDir, 'conversation.json'), 'utf8'),
			);
		} catch {
			continue;
		}

		// Each conversation ends with [… user, assistant]. Extract the last pair.
		const last = conversation.at(-1);
		const secondLast = conversation.at(-2);
		if (last?.role === 'assistant' && secondLast?.role === 'user') {
			turns.push({
				runDir: run.runDir,
				timestamp: run.timestamp,
				model: run.model,
				ok: run.ok ?? null,
				tokens: run.tokens,
				user: messageContentToString(secondLast.content),
				assistant: messageContentToString(last.content),
			});
		}
	}

	// Return null when no turns could be extracted so the caller can surface a
	// clear error rather than silently printing an empty session header.
	if (turns.length === 0) {
		return null;
	}

	return { sessionId, turns };
}

// Normalise a message content field to a plain string. OpenAI-compatible APIs
// may return either a string or an array of content blocks.
function messageContentToString(content) {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content.map((block) => block.text ?? '').join('');
	}
	return '';
}
