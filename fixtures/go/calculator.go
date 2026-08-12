package calculator

// CalculateTotal sums the price of all items.
func CalculateTotal(prices []float64) float64 {
	total := 0.0
	for _, p := range prices {
		total += p
	}
	return total
}

// ApplyDiscount applies a percentage discount to a total.
func ApplyDiscount(total, percent float64) float64 {
	if percent < 0 || percent > 100 {
		panic("percent must be 0-100")
	}
	return total * (1 - percent/100)
}
