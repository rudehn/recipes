"""Spotting ingredient rows that will price or shop wrongly.

Every case here is a row that was actually saved by an import and then
priced or ordered wrongly on a real list. The checks are string checks, so
what is worth proving is which reason wins, and that honest rows - salt to
taste, a garnish - are left alone.
"""

import pytest

from app.services.lint import ingredient_issue


@pytest.mark.parametrize(
    ("name", "quantity", "unit", "expected"),
    [
        # The amount ended up in the name, so nothing scales and the cart
        # orders one.
        ("Optional: 1 diced ripe avocado", None, None, "amount_in_name"),
        ("1 avocado", None, None, "amount_in_name"),
        ("½ cup sugar", None, None, "amount_in_name"),
        # A package size in the name pollutes the search and the count.
        ("22-ounce bag frozen waffle fries", 1, None, "check_line"),
        ("1-ounce packet ranch seasoning mix", 1, None, "check_line"),
        # Nothing can price "or".
        ("broth or milk", 0.5, "cup", "check_line"),
        ("cream cheese or sour cream", 1, "cup", "check_line"),
        # The wrong half of a line, or no ingredient at all.
        ("boneless", 1, None, "check_line"),
        ("firmly", 0.5, "cup", "check_line"),
        ("a few sprigs of herbs", None, None, "check_line"),
        ("double pie crust*", 1, None, "check_line"),
        # No amount where one is expected.
        ("lettuce", None, None, "no_amount"),
        ("burger pickles", None, None, "no_amount"),
        # Honest rows.
        ("salt", None, None, None),
        ("black pepper", None, None, None),
        ("kosher salt, to taste", None, None, None),
        ("fresh parsley, for garnish", None, None, None),
        ("cooking spray", None, None, None),
        ("salt or to taste", None, None, None),
        ("all-purpose flour", 2, "cup", None),
        ("boneless skinless chicken thighs", 1.5, "lb", None),
    ],
)
def test_the_reason_a_row_will_shop_wrongly(name, quantity, unit, expected):
    assert ingredient_issue(name, quantity, unit) == expected


def test_the_most_serious_reason_wins():
    """A row can be wrong in several ways; the list shows one."""
    assert ingredient_issue("Optional: 1 broth or milk", None, None) == "amount_in_name"
