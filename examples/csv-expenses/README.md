# CSV Expense Analyzer Example

A small CSV reporting tool used as a Kodr example app.

## Usage

```sh
npm test
npm run report
node src/cli.mjs data/sample.csv
```

Input CSV files must include:

```csv
date,description,category,amount
2026-05-01,Coffee,Food,4.50
```

The report prints totals by month and category.
