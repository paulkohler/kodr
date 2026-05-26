import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import {
	analyzeExpenseCsv,
	parseCsv,
	renderReport,
	rowsToExpenses,
} from '../src/expenses.mjs';

const execFileAsync = promisify(execFile);

describe('csv expense analyzer', () => {
	it('parses quoted fields, commas, and escaped quotes', () => {
		const rows = parseCsv(
			'date,description,category,amount\n2026-05-01,"Train, airport",Travel,18.75\n2026-05-02,"Notebook ""work""",Office,12.30\n',
		);

		assert.deepEqual(rows[1], [
			'2026-05-01',
			'Train, airport',
			'Travel',
			'18.75',
		]);
		assert.equal(rows[2][1], 'Notebook "work"');
	});

	it('rejects non-string CSV input', () => {
		assert.throws(
			() => parseCsv(123),
			(error) =>
				error instanceof TypeError &&
				error.message === 'parseCsv expects a string input',
		);
	});

	it('validates required columns and fields', () => {
		assert.throws(
			() => rowsToExpenses([['date'], ['2026-05-01']]),
			/Row 1 is missing required CSV column 'description'/u,
		);
		assert.throws(
			() =>
				rowsToExpenses([
					['date', 'description', 'category', 'amount'],
					['05-01-2026', 'Coffee', 'Food', '4.50'],
				]),
			/invalid date/u,
		);
		assert.throws(
			() =>
				rowsToExpenses([
					['date', 'description', 'category', 'amount'],
					['2026-05-01', 'Coffee', 'Food', 'nope'],
				]),
			/invalid amount/u,
		);
	});

	it('groups totals by month and category', () => {
		const analysis = analyzeExpenseCsv(
			'date,description,category,amount\n2026-05-01,Coffee,Food,4.50\n2026-05-02,Train,Travel,18.75\n2026-06-03,Lunch,Food,15.20\n',
		);

		assert.equal(analysis.total, 38.45);
		assert.deepEqual(analysis.byMonth, {
			'2026-05': 23.25,
			'2026-06': 15.2,
		});
		assert.deepEqual(analysis.byCategory, {
			Food: 19.7,
			Travel: 18.75,
		});
	});

	it('renders a readable report', () => {
		const report = renderReport({
			byCategory: { Food: 19.7, Travel: 18.75 },
			byMonth: { '2026-05': 23.25, '2026-06': 15.2 },
			total: 38.45,
		});

		assert.match(report, /Total: 38\.45/u);
		assert.match(report, /- 2026-05: 23\.25/u);
		assert.match(report, /- Food: 19\.70/u);
	});

	it('prints a report from the CLI', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'csv-expenses-'));
		const csv = join(dir, 'expenses.csv');
		await writeFile(
			csv,
			'date,description,category,amount\n2026-05-01,Coffee,Food,4.50\n',
			'utf8',
		);

		const { stdout } = await execFileAsync('node', ['src/cli.mjs', csv], {
			cwd: new URL('..', import.meta.url),
		});

		assert.match(stdout, /Total: 4\.50/u);
		assert.match(stdout, /- Food: 4\.50/u);
	});
});
