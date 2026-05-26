import { readFile } from 'node:fs/promises';

const REQUIRED_HEADERS = ['date', 'description', 'category', 'amount'];

export async function analyzeExpenseFile(path) {
	return analyzeExpenseCsv(await readFile(path, 'utf8'));
}

export function analyzeExpenseCsv(csv) {
	const rows = parseCsv(csv);
	const expenses = rowsToExpenses(rows);

	return {
		byCategory: groupByCategory(expenses),
		byMonth: groupByMonth(expenses),
		expenses,
		total: roundMoney(
			expenses.reduce((sum, expense) => sum + expense.amount, 0),
		),
	};
}

export function parseCsv(csv) {
	const rows = [];
	let field = '';
	let row = [];
	let quoted = false;

	for (let index = 0; index < csv.length; index += 1) {
		const char = csv[index];

		if (quoted) {
			if (char === '"' && csv[index + 1] === '"') {
				field += '"';
				index += 1;
			} else if (char === '"') {
				quoted = false;
			} else {
				field += char;
			}
			continue;
		}

		if (char === '"') {
			quoted = true;
		} else if (char === ',') {
			row.push(field);
			field = '';
		} else if (char === '\n') {
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else if (char !== '\r') {
			field += char;
		}
	}

	if (quoted) {
		throw new Error('CSV has an unterminated quoted field');
	}

	if (field || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows.filter((item) => item.some((cell) => cell.trim() !== ''));
}

export function rowsToExpenses(rows) {
	if (rows.length === 0) {
		return [];
	}

	const headers = rows[0].map((header) => header.trim());
	for (const header of REQUIRED_HEADERS) {
		if (!headers.includes(header)) {
			throw new Error(`Row 1 is missing required CSV column '${header}'`);
		}
	}

	return rows.slice(1).map((row, index) => {
		const record = Object.fromEntries(
			headers.map((header, headerIndex) => [header, row[headerIndex] || '']),
		);
		return validateExpense(record, index + 2);
	});
}

export function groupByMonth(expenses) {
	return sortObject(group(expenses, (expense) => expense.date.slice(0, 7)));
}

export function groupByCategory(expenses) {
	return sortObject(group(expenses, (expense) => expense.category));
}

export function renderReport(analysis) {
	const lines = [`Total: ${formatMoney(analysis.total)}`, '', 'By month:'];

	for (const [month, total] of Object.entries(analysis.byMonth)) {
		lines.push(`- ${month}: ${formatMoney(total)}`);
	}

	lines.push('', 'By category:');
	for (const [category, total] of Object.entries(analysis.byCategory)) {
		lines.push(`- ${category}: ${formatMoney(total)}`);
	}

	return `${lines.join('\n')}\n`;
}

function validateExpense(record, rowNumber) {
	const date = record.date.trim();
	const description = record.description.trim();
	const category = record.category.trim();
	const amount = Number(record.amount);

	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
		throw new Error(`Row ${rowNumber} has invalid date '${date}'`);
	}
	if (!description) {
		const rawDesc = record.description;
		throw new Error(
			`Row ${rowNumber} has empty description (value: "${rawDesc}")`,
		);
	}
	if (!category) {
		const rawCat = record.category;
		throw new Error(`Row ${rowNumber} has empty category (value: "${rawCat}")`);
	}
	if (!Number.isFinite(amount)) {
		throw new Error(`Row ${rowNumber} has invalid amount '${record.amount}'`);
	}

	return {
		amount: roundMoney(amount),
		category,
		date,
		description,
	};
}

function group(expenses, keyFor) {
	const totals = {};
	for (const expense of expenses) {
		const key = keyFor(expense);
		totals[key] = roundMoney((totals[key] || 0) + expense.amount);
	}
	return totals;
}

function sortObject(value) {
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function formatMoney(value) {
	return value.toFixed(2);
}

function roundMoney(value) {
	return Math.round(value * 100) / 100;
}
