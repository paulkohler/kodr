import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION = roadmapVersion();

export function roadmapVersion(root = ROOT) {
	const roadmap = readFileSync(join(root, 'roadmap.md'), 'utf8');
	const phases = [...roadmap.matchAll(/^- \[x\] (?<phase>\d{2}) /gmu)].map(
		(match) => Number(match.groups.phase),
	);
	const latest = Math.max(...phases);
	return `0.0.${latest}`;
}
