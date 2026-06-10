import {
	access,
	copyFile,
	readFile,
	readdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { gitTreeState } from './git-workspace.mjs';
import { contentHash, jailedPath } from './safe-writes.mjs';

// Revert the most recent applied run using its writes.json manifest plus the
// safe-write backups created at apply time. Git is informational here (tree
// state is recorded); the revert itself is backup-based so non-git workspaces
// work identically. Refuses when any applied file was edited after the apply.
export async function undoLastApply(cwd, options = {}) {
	const target = await findLastAppliedRun(cwd);
	if (!target) {
		return {
			ok: false,
			message: 'No applied run with recorded writes was found under .kodr/runs',
			reason: 'no-applied-run',
		};
	}
	if (target.alreadyUndone) {
		return {
			ok: false,
			message: `The last applied run was already undone: ${target.runDir}`,
			reason: 'already-undone',
			runDir: target.runDir,
		};
	}

	// One revert action per path. Patches produce several write records for the
	// same file but only one final on-disk content and one backup.
	const byPath = new Map();
	for (const write of target.writes) {
		byPath.set(write.path, write);
	}

	const conflicts = [];
	const plan = [];
	for (const write of byPath.values()) {
		const jailed = await jailedPath(cwd, write.path);
		if (typeof write.hash !== 'string' || write.hash.length === 0) {
			conflicts.push({
				path: write.path,
				reason:
					'No applied-content hash was recorded for this write (run predates undo support); cannot verify the file is unchanged',
			});
			continue;
		}
		const current = await readOptional(jailed.absolute);
		if (current === null) {
			conflicts.push({
				path: write.path,
				reason: 'File no longer exists; it was removed after the apply',
			});
			continue;
		}
		if (contentHash(current) !== write.hash) {
			conflicts.push({
				path: write.path,
				reason: 'File was modified after the apply',
			});
			continue;
		}
		if (write.status === 'create') {
			plan.push({
				action: 'delete',
				absolute: jailed.absolute,
				path: write.path,
			});
			continue;
		}
		if (!write.backupPath || !(await exists(write.backupPath))) {
			conflicts.push({
				path: write.path,
				reason: 'Backup file is missing; cannot restore the pre-apply content',
			});
			continue;
		}
		plan.push({
			action: 'restore',
			absolute: jailed.absolute,
			backupPath: write.backupPath,
			path: write.path,
		});
	}

	if (conflicts.length > 0) {
		return {
			conflicts,
			message:
				'Refusing to undo: some applied files changed after the run. Resolve them manually or revert via git.',
			ok: false,
			reason: 'conflict',
			runDir: target.runDir,
		};
	}

	for (const step of plan) {
		if (step.action === 'delete') {
			await unlink(step.absolute);
		} else {
			await copyFile(step.backupPath, step.absolute);
		}
	}

	const record = {
		files: plan.map((step) => ({ action: step.action, path: step.path })),
		ok: true,
		treeState: (await gitTreeState(cwd)).state,
		undoneAt: new Date().toISOString(),
	};
	await writeFile(
		join(target.runDir, 'undo.json'),
		`${JSON.stringify(record, null, 2)}\n`,
		'utf8',
	);

	return {
		files: record.files,
		message: `Reverted ${record.files.length} file(s) from ${target.runDir}`,
		ok: true,
		reason: 'undone',
		runDir: target.runDir,
	};
}

// Newest run directory whose writes.json shows an applied change set. Run dir
// names are ISO timestamps, so lexicographic descending = newest first.
async function findLastAppliedRun(cwd) {
	const runsDir = join(cwd, '.kodr', 'runs');
	let entries;
	try {
		entries = await readdir(runsDir, { withFileTypes: true });
	} catch {
		return null;
	}

	const names = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.reverse();

	for (const name of names) {
		const runDir = join(runsDir, name);
		let writeResult;
		try {
			writeResult = JSON.parse(
				await readFile(join(runDir, 'writes.json'), 'utf8'),
			);
		} catch {
			continue;
		}
		if (writeResult?.applied !== true || !(writeResult.writes || []).length) {
			continue;
		}
		return {
			alreadyUndone: await exists(join(runDir, 'undo.json')),
			runDir,
			writes: writeResult.writes,
		};
	}

	return null;
}

async function readOptional(path) {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
