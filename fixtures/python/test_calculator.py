from calculator import calculate_total, apply_discount


def test_calculate_total_basic():
    items = [{"price": 10}, {"price": 20}]
    assert calculate_total(items) == 30


def test_apply_discount_zero():
    assert apply_discount(100, 0) == 100


def test_apply_discount_full():
    assert apply_discount(100, 100) == 0
