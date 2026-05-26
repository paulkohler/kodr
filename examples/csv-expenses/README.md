# CSV Expense Analyzer Example

A Kodr-generated CSV reporting tool used as a sample app for parser, validation, aggregation, and CLI workflows.

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
