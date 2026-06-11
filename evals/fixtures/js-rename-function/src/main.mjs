import { processItem } from './helpers.mjs';

export function runPipeline(items) {
	return items.map(processItem);
}
