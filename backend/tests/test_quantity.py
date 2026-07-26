import pytest

from app.services.quantity import format_quantity


@pytest.mark.parametrize(
    "value,expected",
    [
        (0, "0"),
        (1, "1"),
        (12, "12"),
        (0.5, "½"),
        (0.25, "¼"),
        (0.75, "¾"),
        (0.125, "⅛"),
        (1.5, "1½"),
        (2.25, "2¼"),
        (3.75, "3¾"),
    ],
)
def test_common_fractions(value, expected):
    assert format_quantity(value) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        (1 / 3, "⅓"),
        (2 / 3, "⅔"),
        (0.33, "⅓"),
        (0.67, "⅔"),
        (1 / 6, "⅙"),
        (2 + 2 / 3, "2⅔"),
    ],
)
def test_thirds_and_sixths_survive_lost_precision(value, expected):
    """The cases decimals handle worst: 0.3333 stored, or 0.33 typed."""
    assert format_quantity(value) == expected


@pytest.mark.parametrize(
    "value,expected",
    [
        (0.35, "0.35"),
        (0.3, "0.3"),
        (2.05, "2.05"),
    ],
)
def test_values_far_from_a_fraction_stay_decimal(value, expected):
    assert format_quantity(value) == expected


@pytest.mark.parametrize("value,expected", [(0.2, "0.2"), (1.4, "1.4"), (0.6, "0.6")])
def test_fifths_stay_decimal(value, expected):
    """No measuring spoon has a ⅖ on it, and serving-scaling makes fifths
    often enough that snapping to them would be noise."""
    assert format_quantity(value) == expected


def test_near_whole_values_round_to_whole():
    assert format_quantity(0.999) == "1"
    assert format_quantity(2.004) == "2"
    assert format_quantity(1.996) == "2"


def test_negative_stays_decimal():
    # Unreachable via the API, but a glyph would drop the sign silently.
    assert format_quantity(-0.5) == "-0.5"
