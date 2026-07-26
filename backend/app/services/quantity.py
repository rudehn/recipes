"""Formats ingredient quantities the way a recipe writes them.

Quantities are stored as floats because that is what arithmetic (scaling by
servings, summing across recipes) needs, but "0.25 cups flour" is not how
anyone writes a shopping list. `format_quantity` snaps a float back to the
nearest common cooking fraction and renders the matching glyph, so 0.25
becomes "1/4" and 1.5 becomes "1 1/2" (each as a single character). Anything
that isn't close to one of those fractions keeps its decimal form.

Mixed numbers are written tight ("1½", no space) because the grocery list
already joins separate amounts with " + "; a space here would make
"1 ½ cups + 2 tbsp" read as three amounts instead of two.
"""

# Reduced fractions with the denominators cooks actually measure in (2, 3, 4,
# 6, 8), paired with their Unicode glyph. Fifths are deliberately absent even
# though recipe_import can parse them: measuring spoons have no ⅖, so a 1.4
# that fell out of serving-scaling reads better as "1.4" than "1⅖".
FRACTION_GLYPHS: list[tuple[float, str]] = [
    (1 / 8, "⅛"),
    (1 / 6, "⅙"),
    (1 / 4, "¼"),
    (1 / 3, "⅓"),
    (3 / 8, "⅜"),
    (1 / 2, "½"),
    (5 / 8, "⅝"),
    (2 / 3, "⅔"),
    (3 / 4, "¾"),
    (5 / 6, "⅚"),
    (7 / 8, "⅞"),
]

# How far a value may sit from a fraction and still be shown as one. Tight
# enough that a deliberate 0.35 stays decimal, loose enough to catch thirds
# that lost precision on the way through storage or rounding (0.33, 0.67).
SNAP_TOLERANCE = 0.01


def _format_decimal(q: float) -> str:
    q = round(q, 2)
    if q == int(q):
        return str(int(q))
    return f"{q:g}"


def _nearest_glyph(remainder: float) -> str | None:
    value, glyph = min(FRACTION_GLYPHS, key=lambda f: abs(remainder - f[0]))
    return glyph if abs(remainder - value) <= SNAP_TOLERANCE else None


def format_quantity(q: float) -> str:
    """Render a quantity for display: "1½", "¾", "3", or "0.35"."""
    if q < 0:
        # Not reachable through the API (quantities are non-negative), but a
        # fraction glyph would silently drop the sign, so stay decimal.
        return _format_decimal(q)

    whole = int(q)
    remainder = q - whole
    if remainder >= 1 - SNAP_TOLERANCE:
        whole, remainder = whole + 1, 0.0
    if remainder <= SNAP_TOLERANCE:
        return str(whole)

    glyph = _nearest_glyph(remainder)
    if glyph is None:
        return _format_decimal(q)
    return f"{whole}{glyph}" if whole else glyph
