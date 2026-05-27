import { createRunArtifacts } from './artifacts.mjs';
import { buildWorkspaceContext } from './context-packer.mjs';

const STOP_MARKERS = ['DONE', 'NO_CHANGES', 'KODR_STOP'];

export async function runCycles(cwd, options) {
	const maxCycles = options.cycles;
	const cycle = options.cycle;
	const results = [];

	for (let index = 1; index <= maxCycles; index += 1) {
		const runDir = await createRunArtifacts(
			cwd,
			`${options.out || '.kodr/runs'}/cycle-${index}`,
		);
		const context = await buildWorkspaceContext(cwd);
		const result = await cycle({
			context,
			index,
			runDir,
		});
		results.push({
			...result,
			index,
			runDir,
		});

		if (hasStopMarker(result.text || '')) {
			break;
		}
	}

	return {
		cycles: results,
		stoppedEarly: results.length < maxCycles,
	};
}

export function hasStopMarker(text) {
	return STOP_MARKERS.some((marker) => text.includes(marker));
}
