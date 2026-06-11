package mathfix

import "testing"

func TestAdd(t *testing.T) {
	cases := []struct{ a, b, want int }{
		{3, 4, 7},
		{0, 0, 0},
		{-1, 1, 0},
	}
	for _, c := range cases {
		got := Add(c.a, c.b)
		if got != c.want {
			t.Errorf("Add(%d, %d) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestMultiply(t *testing.T) {
	if got := Multiply(3, 4); got != 12 {
		t.Errorf("Multiply(3, 4) = %d, want 12", got)
	}
}
