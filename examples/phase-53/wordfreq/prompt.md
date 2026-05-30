Write a Go program called `wordfreq` that:

- Reads one or more text files given as command-line arguments (or stdin if no files are given).
- Counts word frequency (case-insensitive, strip punctuation).
- Accepts a `-n` flag for top-N output (default 10).
- Prints results as: `count\tword`, sorted descending by count, then alphabetically by word for ties.
- Exits with a non-zero code and an error message on bad input.

Produce:
- `main.go`
- `wordfreq_test.go` with at least three table-driven tests covering: basic counting, the -n flag, and tie-breaking order.
- `go.mod` with module name `wordfreq`.

No external dependencies. Standard library only.
