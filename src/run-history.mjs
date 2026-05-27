import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
		});
	}

	runs.sort((a, b) => a.runDir.localeCompare(b.runDir));
	return runs;
}
