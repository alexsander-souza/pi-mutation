package calculator

import "testing"

func TestCalculateTotalBasic(t *testing.T) {
	got := CalculateTotal([]float64{10, 20})
	if got != 30 {
		t.Errorf("CalculateTotal([10, 20]) = %v, want 30", got)
	}
}

func TestApplyDiscountZero(t *testing.T) {
	got := ApplyDiscount(100, 0)
	if got != 100 {
		t.Errorf("ApplyDiscount(100, 0) = %v, want 100", got)
	}
}
