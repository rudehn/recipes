/**
 * Ingredient quantities as recipes write them, not as floats store them.
 *
 * Quantities travel through the API as numbers because that is what scaling
 * by servings needs, but "0.25 cup flour" is not how anyone reads a recipe.
 * `formatQuantity` snaps a number back to the nearest fraction a cook can
 * actually measure; `parseQuantity` accepts those same fractions back when
 * someone types one into the recipe form.
 *
 * Kept in step with backend/app/services/quantity.py, which does the same job
 * for the grocery list. The two must agree or the same amount would read
 * differently on the recipe page and the shopping list.
 */

/**
 * Reduced fractions with the denominators cooks measure in (2, 3, 4, 6, 8),
 * paired with their Unicode glyph. Fifths are deliberately absent: measuring
 * spoons have no ⅖, so a 1.4 that fell out of serving-scaling reads better as
 * "1.4" than "1⅖".
 */
const FRACTION_GLYPHS: [number, string][] = [
  [1 / 8, "⅛"],
  [1 / 6, "⅙"],
  [1 / 4, "¼"],
  [1 / 3, "⅓"],
  [3 / 8, "⅜"],
  [1 / 2, "½"],
  [5 / 8, "⅝"],
  [2 / 3, "⅔"],
  [3 / 4, "¾"],
  [5 / 6, "⅚"],
  [7 / 8, "⅞"],
];

/**
 * Every fraction glyph the importer might have parsed, so text that came from
 * a recipe site round-trips through the edit form unchanged.
 */
const GLYPH_VALUES: Record<string, number> = {
  "½": 1 / 2,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 1 / 4,
  "¾": 3 / 4,
  "⅕": 1 / 5,
  "⅖": 2 / 5,
  "⅗": 3 / 5,
  "⅘": 4 / 5,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};

/**
 * How far a value may sit from a fraction and still be shown as one. Tight
 * enough that a deliberate 0.35 stays decimal, loose enough to catch thirds
 * that lost precision in storage or rounding (0.33, 0.67).
 */
const SNAP_TOLERANCE = 0.01;

function formatDecimal(q: number): string {
  return String(parseFloat(q.toFixed(2)));
}

function nearestGlyph(remainder: number): string | null {
  let best = FRACTION_GLYPHS[0];
  for (const candidate of FRACTION_GLYPHS) {
    if (Math.abs(remainder - candidate[0]) < Math.abs(remainder - best[0])) {
      best = candidate;
    }
  }
  return Math.abs(remainder - best[0]) <= SNAP_TOLERANCE ? best[1] : null;
}

/**
 * Render a quantity on its own: "1½", "¾", "3", or "0.35". Mixed numbers are
 * written tight (no space) so a grocery line joining amounts with " + " can't
 * be misread as having more amounts than it does.
 */
export function formatAmount(q: number): string {
  // Unreachable through the API (quantities are non-negative), but a glyph
  // would drop the sign silently.
  if (q < 0) return formatDecimal(q);

  let whole = Math.floor(q);
  let remainder = q - whole;
  if (remainder >= 1 - SNAP_TOLERANCE) {
    whole += 1;
    remainder = 0;
  }
  if (remainder <= SNAP_TOLERANCE) return String(whole);

  const glyph = nearestGlyph(remainder);
  if (glyph === null) return formatDecimal(q);
  return whole ? `${whole}${glyph}` : glyph;
}

/** Render a quantity with its unit: "1½ cups", "3", or "" when unquantified. */
export function formatQuantity(q: number | null, unit: string | null): string {
  if (q === null) return "";
  const amount = formatAmount(q);
  return unit ? `${amount} ${unit}` : amount;
}

/**
 * Read a typed quantity back into a number, accepting the fractions we show:
 * "1½", "1 1/2", "3/4", "¾", and plain decimals. Returns null for blank input
 * and NaN for anything unparseable, so callers can tell the two apart.
 */
export function parseQuantity(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;

  // "1½" -> "1 ½" so every part is whitespace-separated.
  const parts = trimmed
    .replace(/(\d)([¼-¾⅐-⅞])/g, "$1 $2")
    .split(/\s+/);

  let total = 0;
  for (const part of parts) {
    if (part in GLYPH_VALUES) {
      total += GLYPH_VALUES[part];
      continue;
    }
    const fraction = part.match(/^(\d+)\/(\d+)$/);
    if (fraction) {
      const denominator = Number(fraction[2]);
      if (denominator === 0) return NaN;
      total += Number(fraction[1]) / denominator;
      continue;
    }
    if (!/^\d*\.?\d+$/.test(part)) return NaN;
    total += Number(part);
  }
  return total;
}
