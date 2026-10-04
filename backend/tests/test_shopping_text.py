"""Reading a pasted shopping list.

The text comes from wherever the list was kept - Notes, Reminders, a text
message, a markdown checklist - and carries that place's decoration. What
matters is that every line becomes the thing the shopper meant, with the
count they meant, and that a line they had already ticked off is not bought
again.
"""

import pytest

from app.services.kroger.units import COUNT, VOLUME, WEIGHT, Measure
from app.services.shopping_text import MAX_LINES, read_shopping_text


def names(text: str) -> list[str]:
    return [line.name for line in read_shopping_text(text).lines]


def only(text: str):
    lines = read_shopping_text(text).lines
    assert len(lines) == 1, lines
    return lines[0]


def test_one_item_per_line():
    assert names("milk\neggs\nbread") == ["milk", "eggs", "bread"]


def test_blank_lines_and_surrounding_space_are_ignored():
    assert names("\n  milk  \n\n\teggs\n") == ["milk", "eggs"]


@pytest.mark.parametrize(
    "line",
    [
        "- milk",
        "* milk",
        "• milk",
        "– milk",
        "◦ milk",
        "☐ milk",
        # The box recipe cards draw beside each ingredient, copied with it.
        "▢ milk",
        "[ ] milk",
        "- [ ] milk",
        "1. milk",
        "2) milk",
    ],
)
def test_bullets_checkboxes_and_numbering_are_stripped(line):
    assert names(line) == ["milk"]


@pytest.mark.parametrize(
    "line", ["- [x] milk", "[X] milk", "☑ milk", "✓ milk", "✔ milk", "✅ milk"]
)
def test_a_ticked_line_is_left_out_and_named(line):
    """A tick on a list someone has been shopping from means it is bought."""
    read = read_shopping_text(f"{line}\neggs")
    assert [item.name for item in read.lines] == ["eggs"]
    assert read.ticked == ["milk"]


@pytest.mark.parametrize("line", ["Produce:", "# Dairy", "## Household", "Costco:"])
def test_headings_are_not_items(line):
    assert names(f"{line}\nmilk") == ["milk"]


def test_a_number_on_its_own_is_a_count_of_packages():
    """On a shopping list "2 eggs" is two cartons, not two eggs."""
    item = only("2 eggs")
    assert (item.name, item.packages, item.need) == ("eggs", 2, None)


@pytest.mark.parametrize(
    "line",
    ["eggs x2", "eggs x 2", "eggs ×2", "eggs X2", "2x eggs", "2 x eggs", "x2 eggs", "eggs (2)"],
)
def test_every_way_of_writing_a_count(line):
    item = only(line)
    assert (item.name, item.packages) == ("eggs", 2)


def test_no_number_is_one():
    item = only("milk")
    assert (item.packages, item.need, item.amount) == (1, None, None)


def test_a_container_is_a_package_too():
    """A can, a bag, a box: what is bought is the container."""
    item = only("3 cans black beans")
    assert (item.name, item.packages, item.need) == ("black beans", 3, None)


def test_a_weight_is_an_amount_to_cover():
    item = only("2 lb ground beef")
    assert item.name == "ground beef"
    assert item.packages is None
    assert item.need == Measure(WEIGHT, pytest.approx(907.184))
    assert item.amount == "2 lb"


@pytest.mark.parametrize("line", ["1 gallon milk", "2 gallons milk", "1 gal milk"])
def test_a_volume_is_an_amount_to_cover(line):
    item = only(line)
    assert item.name == "milk"
    assert item.need is not None and item.need.dimension == VOLUME


def test_a_dozen_is_counted_as_twelve():
    item = only("2 dozen eggs")
    assert item.name == "eggs"
    assert item.need == Measure(COUNT, 24)
    assert item.amount == "2 dozen"


def test_a_fraction_of_a_package_rounds_up():
    assert only("1.5 eggs").packages == 2


def test_one_line_of_commas_is_a_list():
    """How a list arrives in a text message."""
    assert names("milk, eggs, bread") == ["milk", "eggs", "bread"]


def test_commas_inside_a_multi_line_list_belong_to_the_item():
    assert names("chicken thighs, boneless\nmilk") == ["chicken thighs, boneless", "milk"]


def test_the_same_thing_twice_is_one_line_with_the_counts_added():
    read = read_shopping_text("eggs\n2 eggs\nmilk")
    assert [(item.name, item.packages) for item in read.lines] == [("eggs", 3), ("milk", 1)]


def test_the_same_thing_written_differently_is_still_one_line():
    """Merged on the key every other part of the app buys by."""
    read = read_shopping_text("Eggs\nlarge eggs")
    assert [(item.key, item.packages) for item in read.lines] == [("egg", 2)]


def test_the_same_amount_twice_is_added():
    item = only("1 lb ground beef\n2 lb ground beef")
    assert item.need == Measure(WEIGHT, pytest.approx(3 * 453.592))
    assert item.amount == "3 lb"


def test_an_amount_and_a_count_of_the_same_thing_are_read_as_packages():
    """No single amount covers both, so each line is taken as a package."""
    item = only("1 lb ground beef\nground beef x2")
    assert (item.packages, item.need, item.amount) == (3, None, None)


def test_the_order_of_the_paste_is_kept():
    assert names("zucchini\napples\nmilk") == ["zucchini", "apples", "milk"]


def test_a_line_that_names_nothing_is_skipped():
    assert names("- \n[ ]\n2\nmilk") == ["milk"]


def test_counts_stop_at_what_can_be_ordered():
    assert only("eggs x500").packages == 99


def test_a_list_longer_than_a_trip_is_cut_short():
    words = [f"food {chr(97 + i % 26)}{chr(97 + i // 26)}" for i in range(MAX_LINES + 20)]
    text = "\n".join(words)
    assert len(read_shopping_text(text).lines) == MAX_LINES
