export const VERSION = '1.0.0';

export function parseArgs(args) {
	const options = { help: false };

	for (const arg of args) {
		if (arg === '--help' || arg === '-h') {
			options.help = true;
		}
	}

	return options;
}
