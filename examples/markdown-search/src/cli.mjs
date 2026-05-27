import { resolve } from 'node:path';
import { loadIndex, searchIndex } from './search.mjs';

const [, , docsDirArg, query] = process.argv;
if (!docsDirArg || !query) {
	console.error('Usage: node src/cli.mjs <docs-dir> <query>');
	process.exit(1);
}

const docsDir = resolve(docsDirArg);

(async () => {
	try {
		const index = await loadIndex(docsDir);
		const results = searchIndex(index, query);
		for (const { path, title, score, snippet } of results) {
			console.log(`${path}: ${title} (score: ${score}) ${snippet}`);
		}
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
})();
