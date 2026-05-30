package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
)

var wordRe = regexp.MustCompile(`[^a-zA-Z0-9]+`)

type entry struct {
	word  string
	count int
}

func analyze(r io.Reader) ([]entry, error) {
	words := make(map[string]int)
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		text := scanner.Text()
		parts := wordRe.Split(text, -1)
		for _, part := range parts {
			w := strings.ToLower(part)
			if w != "" {
				words[w]++
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	var entries []entry
	for w, c := range words {
		entries = append(entries, entry{w, c})
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].count != entries[j].count {
			return entries[i].count > entries[j].count
		}
		return entries[i].word < entries[j].word
	})
	return entries, nil
}

func mergeEntries(a, b []entry) []entry {
	m := make(map[string]int)
	for _, e := range a {
		m[e.word] += e.count
	}
	for _, e := range b {
		m[e.word] += e.count
	}
	var res []entry
	for w, c := range m {
		res = append(res, entry{w, c})
	}
	sort.Slice(res, func(i, j int) bool {
		if res[i].count != res[j].count {
			return res[i].count > res[j].count
		}
		return res[i].word < res[j].word
	})
	return res
}

func topN(entries []entry, n int) []entry {
	if n < 0 {
		n = 0
	}
	if n > len(entries) {
		n = len(entries)
	}
	return entries[:n]
}

func main() {
	n := flag.Int("n", 10, "number of top words to display")
	flag.Parse()

	if *n < 0 {
		fmt.Fprintln(os.Stderr, "error: -n must be non-negative")
		os.Exit(1)
	}

	var allEntries []entry
	var readers []io.Reader
	if flag.NArg() == 0 {
		readers = append(readers, os.Stdin)
	} else {
		for _, filename := range flag.Args() {
			f, err := os.Open(filename)
			if err != nil {
				fmt.Fprintf(os.Stderr, "error: %v\n", err)
				os.Exit(1)
			}
			readers = append(readers, f)
			defer f.Close()
		}
	}

	for _, r := range readers {
		entries, err := analyze(r)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error reading input: %v\n", err)
			os.Exit(1)
		}
		if len(allEntries) == 0 {
			allEntries = entries
		} else {
			allEntries = mergeEntries(allEntries, entries)
		}
	}

	for _, e := range topN(allEntries, *n) {
		fmt.Printf("%d\t%s\n", e.count, e.word)
	}
}
