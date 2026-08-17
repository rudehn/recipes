"""Reading Kroger's size strings, and what the recipe asks for.

Sizes are free text written for a shelf label, not for a parser, so the risk
worth covering is a confident misreading: a size that comes back wrong is
used to choose a package, while one that comes back unknown simply falls back
to the older ranking.
"""

import pytest

from app.services.kroger.units import COUNT, VOLUME, WEIGHT, measure, parse_size


@pytest.mark.parametrize(
    ("size", "dimension", "base"),
    [
        ("5 lb", WEIGHT, 2267.96),
        ("36 oz", WEIGHT, 1020.58),
        ("1 lb", WEIGHT, 453.592),
        ("16 ounce", WEIGHT, 453.592),
        ("2.25 oz", WEIGHT, 63.79),
        ("500 g", WEIGHT, 500.0),
        ("1 kg", WEIGHT, 1000.0),
        ("16.9 fl oz", VOLUME, 499.79),
        ("1 qt", VOLUME, 946.353),
        ("1 pt", VOLUME, 473.176),
        ("12 ct", COUNT, 12.0),
        ("1 each", COUNT, 1.0),
    ],
)
def test_sizes_are_read_into_a_comparable_base(size, dimension, base):
    found = parse_size(size)
    assert found is not None
    assert found.dimension == dimension
    assert found.base == pytest.approx(base, rel=1e-3)


@pytest.mark.parametrize(
    "size",
    [
        # Compound sizes mean opposite things in the same shape: "3 ct / 1 lb"
        # is three one-pound packs, "8 ct / 30.4 ounce" is eight patties
        # weighing 30.4 ounces between them. Nothing in the string says which.
        "3 ct / 1 lb",
        "8 ct / 30.4 ounce",
        "",
        "1 bunch",
        "assorted",
        "lb",
    ],
)
def test_a_size_that_cannot_be_read_is_refused_rather_than_guessed(size):
    assert parse_size(size) is None


def test_a_weight_and_a_volume_are_not_comparable():
    """A pound of flour and two cups of it need a density to relate, which is
    not this module's business."""
    assert parse_size("1 lb").dimension != parse_size("1 qt").dimension


def test_an_amount_with_no_unit_is_a_count():
    """"2 eggs" is two items, which is how a dozen is sold."""
    found = measure(2, None)
    assert found is not None
    assert found.dimension == COUNT
    assert found.base == 2


@pytest.mark.parametrize("quantity", [None, 0, -1])
def test_a_missing_or_empty_amount_is_no_amount(quantity):
    assert measure(quantity, "lb") is None


def test_an_unrecognised_unit_is_no_amount():
    """"1 pinch" and "2 sprigs" answer no package size, and inventing one
    would choose a product on a made-up number."""
    assert measure(1, "pinch") is None
    assert measure(2, "sprig") is None
