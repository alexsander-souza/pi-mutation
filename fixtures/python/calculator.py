def calculate_total(items):
    """Sum the price of all items."""
    total = 0
    for item in items:
        total += item["price"]
    return total


def apply_discount(total, percent):
    """Apply a percentage discount to a total."""
    if percent < 0 or percent > 100:
        raise ValueError("percent must be 0-100")
    return total * (1 - percent / 100)
