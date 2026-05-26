import { analyzeExpenseFile, renderReport } from './expenses.mjs';

const input = process.argv[2];

if (!input || input === '--help') {
	console.log('Usage: node src/cli.mjs <expenses.csv>');
	process.exit(input ? 0 : 1);
}

try {
	const analysis = await analyzeExpenseFile(input);
	process.stdout.write(renderReport(analysis));
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
