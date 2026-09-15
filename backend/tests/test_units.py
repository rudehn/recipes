"""Reading Kroger's size strings, and what the recipe asks for.

Sizes are free text written for a shelf label, not for a parser, so the risk
worth covering is a confident misreading: a size that comes back wrong is
used to choose a package, while one that comes back unknown simply falls back
to the older ranking.
"""

import pytest

from app.services.kroger.density import grams_per_cup, grams_per_piece
from app.services.kroger.units import (
    COUNT,
    VOLUME,
    WEIGHT,
    as_weight,
    cost_to_cover,
    measure,
    packages_to_cover,
    parse_size,
    share_of_package,
    to_cents,
)


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


def test_a_volume_becomes_a_weight_when_the_density_is_known():
    """The bridge recipes need and shops do not have: two cups of flour is
    250 g, which a five pound bag can be compared with."""
    two_cups = measure(2, "cup")
    flour = as_weight(two_cups, grams_per_cup("all-purpose-flour"))
    assert flour.base == pytest.approx(250, rel=1e-3)
    # Sugar is heavier than flour by half again, which is the whole reason a
    # single conversion factor cannot work.
    sugar = as_weight(two_cups, grams_per_cup("granulated-sugar"))
    assert sugar.base == pytest.approx(400, rel=1e-3)


def test_a_weight_passes_through_unchanged():
    assert as_weight(measure(1, "lb"), 125.0).base == pytest.approx(453.592, rel=1e-3)


def test_a_volume_without_a_density_stays_unconvertible():
    """Assuming an unknown ingredient weighs the same as water is exactly the
    guess this is here to avoid."""
    assert as_weight(measure(2, "cup"), None) is None


def test_a_count_never_becomes_a_weight():
    """A dozen eggs weighs nothing in particular."""
    assert as_weight(measure(12, None), 125.0) is None


def test_a_density_is_found_by_walking_the_name_down():
    assert grams_per_cup("all-purpose-flour") == 125.0
    # Falls back through its family rather than failing.
    assert grams_per_cup("unbleached-bread-flour") == 127.0
    assert grams_per_cup("organic-whole-wheat-flour") == 120.0
    # The specific entry beats the general one it would otherwise fall back to.
    assert grams_per_cup("brown-sugar") != grams_per_cup("sugar")


def test_an_unlisted_ingredient_has_no_density():
    """Better no answer than a made-up one: without it the caller falls back
    to ranking that does not need a density."""
    assert grams_per_cup("saffron") is None
    assert grams_per_cup("") is None


def test_a_rate_is_never_charged_below_one_of_its_own_unit():
    """A teaspoon of a $10.99/lb item costs eleven cents by arithmetic, and
    you cannot buy five grams of bacon. Unfloored, that made brown-sugar-cured
    bacon the cheapest way to buy a teaspoon of brown sugar."""
    pound = parse_size("1 lb")
    teaspoon = as_weight(measure(1, "tsp"), grams_per_cup("brown-sugar"))

    assert cost_to_cover(10.99, pound, "WEIGHT", teaspoon) == pytest.approx(10.99)


def test_a_rate_still_scales_up_past_its_unit():
    pound = parse_size("1 lb")
    three_pounds = measure(3, "lb")

    assert cost_to_cover(4.49, pound, "WEIGHT", three_pounds) == pytest.approx(13.47)


@pytest.mark.parametrize(
    ("need", "size", "expected"),
    [
        # Twelve pounds against a five pound bag is three bags.
        (measure(12, "lb"), parse_size("5 lb"), 3),
        (measure(5, "lb"), parse_size("5 lb"), 1),
        # Less than a package is still a package.
        (measure(2, "cup"), parse_size("5 lb"), 1),
        # Counts of different things. Six cloves against a "1 ct" bulb is one
        # bulb; multiplying would buy six.
        (measure(6, None), parse_size("1 ct"), 1),
        # A volume against a volume needs no density at all.
        (measure(6, "quart"), parse_size("1 gal"), 2),
        # And a volume against a weight is one package when there is none.
        (measure(24, "cup"), parse_size("5 lb"), 1),
        # A weight-sold rate rounds up where the price does not: there is no
        # way to order 1.4 lb through this API.
        (measure(1.4, "lb"), parse_size("1 lb"), 2),
        # Nothing readable to divide by.
        (None, parse_size("5 lb"), 1),
        (measure(12, "lb"), parse_size("3 ct / 1 lb"), 1),
    ],
)
def test_how_many_packages_cover_the_week(need, size, expected):
    """The counting half of `cost_to_cover`, on the same conditions: the
    quantity ordered has to be the quantity that was priced."""
    assert packages_to_cover(size, need) == expected


def test_a_volume_of_a_known_ingredient_is_weighed_before_it_is_counted():
    """Twenty-four cups of flour is three kilos and a five pound bag holds
    two and a quarter, so two bags. The density comes from the ingredient's
    name, the same way the ranking found it."""
    assert packages_to_cover(parse_size("5 lb"), measure(24, "cup"), "all-purpose-flour") == 2
    assert cost_to_cover(2.59, parse_size("5 lb"), "UNIT", measure(24, "cup"), "flour") == (
        pytest.approx(5.18)
    )


def test_a_count_is_only_a_count_of_the_same_thing():
    """Twenty eggs against a dozen is two cartons. Six cloves against a bulb
    is still one bulb: garlic is not on the list of things a recipe counts
    in the shop's own pieces, and that list is the whole rule."""
    assert packages_to_cover(parse_size("12 ct"), measure(20, None), "egg") == 2
    assert packages_to_cover(parse_size("12 ct"), measure(20, None), "large-brown-egg") == 2
    assert packages_to_cover(parse_size("1 ct"), measure(6, None), "garlic-clove") == 1


@pytest.mark.parametrize(
    ("amount", "expected"),
    [
        # 1.5 lb of chicken at $4.49 a pound. `round` answers 6.73, because
        # the float under 6.735 is a hair below it.
        (6.735, 6.74),
        # What actually arrives: 1.5 lb of chicken at $4.49/lb, after the
        # ratio behind it came out as 1.4999999999999998.
        (6.734999999999999, 6.74),
        (0.005, 0.01),
        (2.345, 2.35),
        (1.0, 1.0),
    ],
)
def test_money_rounds_the_way_a_till_does(amount, expected):
    assert to_cents(amount) == expected


def test_a_count_compares_when_the_caller_vouches_for_the_piece():
    """The curated list is one way for a count to count; a product that is
    a single piece of produce is the other, and the caller says so."""
    assert packages_to_cover(parse_size("1 each"), measure(3, None), "avocado") == 1
    assert packages_to_cover(parse_size("1 each"), measure(3, None), "avocado", None, True) == 3


def test_a_recipe_uses_a_share_of_a_package_not_the_whole():
    """Two cups of flour is 250 g of a five pound bag, so 11% of its price.
    A rate has no floor here: a costing is not a purchase."""
    two_cups = measure(2, "cup")
    assert share_of_package(2.59, parse_size("5 lb"), "UNIT", two_cups, "flour") == (
        pytest.approx(0.2855, rel=1e-3)
    )
    teaspoon = measure(1, "tsp")
    assert share_of_package(10.99, parse_size("1 lb"), "WEIGHT", teaspoon, "brown-sugar") == (
        pytest.approx(0.111, rel=1e-2)
    )
    # Unrelatable amounts are the caller's problem, and said so.
    bunch = parse_size("1 bunch")
    assert share_of_package(1.29, bunch, "UNIT", measure(2, None), "parsley") is None


def test_vegetables_have_a_density_too():
    """Nine cups of corn against a 10 oz can was one can for want of a
    number: 165 g a cup makes it five."""
    assert packages_to_cover(parse_size("10 oz"), measure(9, "cup"), "corn-kernel") == 6
    assert packages_to_cover(parse_size("10 oz"), measure(3, "cup"), "raw-corn-kernel") == 2


def test_a_counted_ingredient_is_weighed_against_a_shelf_priced_by_weight():
    """One jalapeno against loose peppers at $1.99 a pound was costed the
    whole pound, because a count and a weight could not be related. USDA
    weighs a jalapeno at 14 g, so the recipe uses 3% of that pound."""
    pound = parse_size("1 lb")
    assert grams_per_piece("jalapeno") == pytest.approx(14.0)
    assert share_of_package(1.99, pound, "WEIGHT", measure(1, None), "jalapeno") == (
        pytest.approx(0.0614, abs=0.0005)
    )
    # It is the recipe's piece that is weighed, so three cloves are 9 g.
    assert share_of_package(2.99, pound, "WEIGHT", measure(3, None), "garlic-clove") == (
        pytest.approx(2.99 * 9 / 453.592, rel=1e-3)
    )
    # Buying rounds up to the rate's own unit unless the product is loose.
    assert cost_to_cover(1.99, pound, "WEIGHT", measure(1, None), "jalapeno") == (
        pytest.approx(1.99)
    )


def test_a_shelf_count_is_never_weighed():
    """Only the recipe's side is weighed. A "1 ct" of garlic is a bulb, and
    weighing it as a clove would make a pound of garlic a hundred and fifty
    bulbs."""
    assert packages_to_cover(parse_size("1 ct"), measure(1, "lb"), "garlic") == 1
    assert share_of_package(0.79, parse_size("1 ct"), "UNIT", measure(1, "lb"), "garlic") is None


def test_a_count_with_no_known_piece_weight_stays_unrelated():
    assert share_of_package(9.99, parse_size("1 oz"), "WEIGHT", measure(2, None), "saffron") is None


def test_loose_produce_costs_what_is_bought_not_a_whole_unit():
    """One jalapeno is 14 g of peppers sold loose at $1.99 a pound. The floor
    is for what a shop will not sell smaller - five grams of bacon - and a
    single pepper off the pile is exactly what it will."""
    pound = parse_size("1 lb")
    one = measure(1, None)
    assert cost_to_cover(1.99, pound, "WEIGHT", one, "jalapeno", loose=True) == (
        pytest.approx(1.99 * 14 / 453.592)
    )
    # Packaged and sold by weight, the floor stands.
    teaspoon = measure(1, "tsp")
    assert cost_to_cover(10.99, pound, "WEIGHT", teaspoon, "brown-sugar") == pytest.approx(10.99)
    # And an order is still for at least one: no cart takes 14 g.
    assert packages_to_cover(pound, one, "jalapeno") == 1
