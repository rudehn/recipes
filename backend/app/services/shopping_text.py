"""Reading a shopping list someone pasted in, to send it to the Kroger cart.

A shopping list is not a recipe, and the difference is in what a number
means. A recipe's "2 eggs" is two eggs, a share of a carton. A shopping list's
"2 eggs" is two cartons - the list is already written in things to pick up.
So a number on its own, or a number of containers ("3 cans"), is a count of
packages here, and only a real measure ("2 lb ground beef", "1 gallon milk")
is an amount the store's package sizes are worked out against, the same way
a recipe's is.

The text arrives carrying the decoration of wherever the list was kept:
bullets, checkboxes, numbering, headings for the aisles. That is read past.
A line already ticked off is not, since a tick on a list someone has been
shopping from says it is bought; those are left out and named, so nothing
disappears without saying so.

Lines are merged on the `Identity` key, the one every other part of the app
buys by (ADR 2), so "Eggs" and "large eggs" are one line and one product.
Nothing here is stored: a pasted list goes to the cart and nowhere else.
"""

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field

from ..schemas import MAX_CART_QUANTITY
from .grocery import normalize_unit
from .identity import Identity
from .kroger.units import Measure, measure
from .list_marks import read_list_marks
from .quantity import format_quantity
from .recipe_import import parse_ingredient_line

# More lines than any one trip, so a paste of something that is not a list -
# a whole email, a recipe's method - stops rather than searching the store a
# hundred times over.
MAX_LINES = 100

# "eggs x2", "eggs ×2", "eggs (2)"; and in front, "2x eggs", "x2 eggs".
_COUNT_AFTER = re.compile(r"(?:\s+[x×]\s*(\d+)|\s*\((\d+)\))$", re.I)
_COUNT_BEFORE = re.compile(r"^(?:(\d+)\s*[x×]|[x×]\s*(\d+))\s+", re.I)

# Measure words the recipe parser does not know, because recipes never use
# them, and shopping lists do: "1 gal milk", "2 dozen eggs".
_EXTRA_MEASURES = {"gal", "qt", "pt", "ct", "dozen"}

# Written in full when there is more than one. Abbreviations stay as they are,
# and a dozen is a dozen however many there are.
_ABBREVIATED = {"g", "kg", "oz", "lb", "ml", "l", "tsp", "tbsp", "gal", "qt", "pt", "ct", "fl oz"}


@dataclass(frozen=True)
class ShoppingItem:
    """One thing to buy, as the shopper wrote it.

    Exactly one of `packages` and `need` is set. `packages` is a count stated
    outright - "eggs x2", "3 cans black beans", or nothing, which is one.
    `need` is an amount the package count is worked out to cover, and
    `amount` is that amount as it reads, so a count sent to the cart can be
    checked against it: "2 × 1 lb, for 2 lb".
    """

    key: str
    name: str
    packages: int | None
    need: Measure | None
    amount: str | None


@dataclass(frozen=True)
class ShoppingText:
    lines: list[ShoppingItem]
    # Lines that were already ticked off, by name. Left out, and said so.
    ticked: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class _Line:
    name: str
    packages: int | None = None
    quantity: float | None = None
    unit: str | None = None


def _measure_unit(unit: str) -> str | None:
    """The unit as `units.measure` knows it, singular, or None if it is not a
    measure at all - a can, a bag, a bunch is a container, not an amount."""
    candidates = [unit.casefold().rstrip("."), normalize_unit(unit) or ""]
    candidates += [c[:-1] for c in candidates if c.endswith("s")]
    for candidate in candidates:
        if candidate and measure(1, candidate) is not None:
            return candidate
    return None


def _read_line(text: str) -> _Line:
    """One line of the paste, as a count of packages or an amount to cover."""
    count = _COUNT_AFTER.search(text) or _COUNT_BEFORE.match(text)
    if count:
        number = int(count.group(1) or count.group(2))
        rest = (text[: count.start()] + text[count.end() :]).strip()
        return _Line(name=rest, packages=number)

    parsed = parse_ingredient_line(text)
    name, quantity, unit = parsed.name, parsed.quantity, parsed.unit
    if quantity is not None and unit is None:
        first, _, rest = name.partition(" ")
        if rest and first.casefold() in _EXTRA_MEASURES:
            name, unit = rest, first.casefold()
    if quantity is None:
        return _Line(name=name, packages=1)
    measured = _measure_unit(unit) if unit else None
    if measured is None:
        return _Line(name=name, packages=math.ceil(quantity))
    return _Line(name=name, quantity=quantity, unit=measured)


def _format_amount(per_unit: dict[str, float]) -> str:
    parts = []
    for unit, total in per_unit.items():
        plural = total > 1 and unit not in _ABBREVIATED and unit != "dozen"
        parts.append(f"{format_quantity(total)} {unit}{'s' if plural else ''}")
    return " + ".join(parts)


def _items(text: str) -> list[str]:
    rows = [row.strip() for row in text.splitlines()]
    rows = [row for row in rows if row]
    # A single line of commas is how a list arrives in a text message. In a
    # list of several lines, a comma is part of an item: "chicken, boneless".
    if len(rows) == 1 and "," in rows[0]:
        rows = [part.strip() for part in rows[0].split(",")]
    return rows


def read_shopping_text(text: str, identity: Identity) -> ShoppingText:
    """Every item in a pasted list, merged on what would be bought, in order.

    Names are compared through `identity`, so a merged name pastes as its
    target.
    """
    order: list[str] = []
    names: dict[str, str] = {}
    packages: dict[str, int] = defaultdict(int)
    measured_lines: dict[str, int] = defaultdict(int)
    amounts: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))
    ticked: list[str] = []

    for item in _items(text):
        marks = read_list_marks(item)
        row = marks.text
        if not row or row.endswith(":") or row.startswith("#"):
            continue

        line = _read_line(row)
        # "2" on its own, or a bullet with nothing after it, names nothing.
        if not re.search(r"[^\W\d_]", line.name):
            continue
        key = identity.key(line.name)
        if not key:
            continue
        if marks.ticked:
            ticked.append(line.name)
            continue

        if key not in names:
            if len(order) == MAX_LINES:
                continue
            order.append(key)
            names[key] = line.name
        if line.unit is not None and line.quantity is not None:
            amounts[key][line.unit] += line.quantity
            measured_lines[key] += 1
        else:
            packages[key] += line.packages or 1

    items: list[ShoppingItem] = []
    for key in order:
        need: Measure | None = None
        per_unit = amounts.get(key, {})
        if per_unit and not packages.get(key):
            found = [measure(q, u) for u, q in per_unit.items()]
            dimensions = {m.dimension for m in found if m is not None}
            if len(dimensions) == 1:
                need = Measure(dimensions.pop(), sum(m.base for m in found if m is not None))
        if need is not None:
            items.append(ShoppingItem(key, names[key], None, need, _format_amount(per_unit)))
        else:
            # No single amount covers every line, so each measured line is
            # taken as one package of it rather than guessed at.
            count = packages.get(key, 0) + measured_lines.get(key, 0)
            items.append(
                ShoppingItem(key, names[key], min(max(count, 1), MAX_CART_QUANTITY), None, None)
            )
    return ShoppingText(lines=items, ticked=ticked)
