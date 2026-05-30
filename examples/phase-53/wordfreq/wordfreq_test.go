package main

import (
	"strings"
	"testing"
)

func TestBasicCounting(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []entry
	}{
		{
			name:  "simple words",
			input: "apple banana apple",
			expected: []entry{
				{"apple", 2},
				{"banana", 1},
			},
		},
		{
			name:  "case insensitive",
			input: "Apple APPLE apple",
			expected: []entry{
				{"apple", 3},
			},
		},
		{
			name:  "punctuation stripping",
			input: "test... test! test?",
			expected: []entry{
				{"test", 3},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := strings.NewReader(tt.input)
			entries, err := analyze(r)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(entries) != len(tt.expected) {
				t.Fatalf("expected %d entries, got %d", len(tt.expected), len(entries))
			}
			for i, exp := range tt.expected {
				if entries[i] != exp {
					t.Errorf("entry %d: expected %+v, got %+v", i, exp, entries[i])
				}
			}
		})
	}
}

func TestTieBreaking(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []entry
	}{
		{
			name:  "alphabetical tie-break",
			input: "cherry banana apple cherry banana apple",
			expected: []entry{
				{"apple", 2},
				{"banana", 2},
				{"cherry", 2},
			},
		},
		{
			name:  "mixed counts with ties",
			input: "z y x z y x a b a",
			expected: []entry{
				{"a", 2},
				{"x", 2},
				{"y", 2},
				{"z", 2},
				{"b", 1},
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := strings.NewReader(tt.input)
			entries, err := analyze(r)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(entries) != len(tt.expected) {
				t.Fatalf("expected %d entries, got %d", len(tt.expected), len(entries))
			}
			for i, exp := range tt.expected {
				if entries[i] != exp {
					t.Errorf("entry %d: expected %+v, got %+v", i, exp, entries[i])
				}
			}
		})
	}
}

func TestTopNFlag(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		n        int
		expected int
	}{
		{name: "n=3", input: "a b c d e", n: 3, expected: 3},
		{name: "n=10", input: "a b c", n: 10, expected: 3},
		{name: "n=0", input: "a b c", n: 0, expected: 0},
		{name: "n=-1", input: "a b c", n: -1, expected: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := strings.NewReader(tt.input)
			entries, err := analyze(r)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			result := topN(entries, tt.n)
			if len(result) != tt.expected {
				t.Errorf("n=%d: expected %d entries, got %d", tt.n, tt.expected, len(result))
			}
		})
	}
}
