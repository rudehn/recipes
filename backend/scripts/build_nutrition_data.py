"""Build the bundled nutrition tables from USDA FoodData Central's SR Legacy.

    uv run python scripts/build_nutrition_data.py FoodData_Central_sr_legacy_food_csv_2018-04.zip

Download the zip from https://fdc.nal.usda.gov/download-datasets (SR Legacy,
CSV). The data is public domain. It is read straight from the zip and two
tables are written into `app/services/nutrition/usda/`:

- `foods.csv`: every food with all five figures the app shows, per 100 g.
- `portions.csv`: the kitchen measures USDA weighed for each food - "1 cup,
  chopped" is 160 g of onion, "1 clove" is 3 g of garlic - reduced to grams
  for one of the unit.

SR Legacy rather than Foundation Foods: Foundation is newer but covers a few
hundred foods and weighs almost none of them in kitchen measures, and the
portions are what let "3 cloves garlic" and "2 large eggs" be weighed at all.
SR Legacy is frozen, so these tables only change when this script does.

Both outputs are sorted, so a rebuild that changes nothing diffs as nothing.
"""

import csv
import io
import re
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "services" / "nutrition" / "usda"

# USDA nutrient ids for what the app shows, in the column order written.
NUTRIENTS = {
    "1008": "kcal",
    "1003": "protein_g",
    "1004": "fat_g",
    "1005": "carbs_g",
    "1093": "sodium_mg",
}

# Categories that are not ingredients, and would only ever be wrong answers
# in the food picker: baby food, fast food and restaurant meals, prepared
# entrees, branded products, and USDA's own laboratory controls.
EXCLUDED_CATEGORIES = {
    "Baby Foods",
    "Fast Foods",
    "Meals, Entrees, and Side Dishes",
    "American Indian/Alaska Native Foods",
    "Restaurant Foods",
    "Branded Food Products Database",
    "Quality Control Materials",
}

_UNIT_RE = re.compile(r"^(fl oz|extra large|[a-z]+)")

# Spellings of one measure, reduced to the form the app's units use.
_UNIT_SPELLINGS = {
    "tablespoon": "tbsp",
    "teaspoon": "tsp",
    "extra large": "extra-large",
    "leave": "leaf",
    "leaves": "leaf",
}


def _rows(archive: zipfile.ZipFile, name: str) -> csv.DictReader:
    path = next(n for n in archive.namelist() if n.endswith("/" + name))
    return csv.DictReader(io.TextIOWrapper(archive.open(path), encoding="utf-8"))


def portion_unit(modifier: str) -> str:
    """The measure a portion is counted in: "cup, chopped" is a cup.

    USDA's structured unit column says "undetermined" for every SR Legacy
    portion, so the unit is read off the front of the free-text modifier.
    Plurals are reduced ("3 cloves" is a clove) and spellings joined
    ("tablespoon" is tbsp), and anything without a leading word ("1\" cube")
    comes back empty and is never looked up.
    """
    match = _UNIT_RE.match(modifier.strip().casefold())
    if not match:
        return ""
    unit = match.group(1)
    if unit.endswith("ies"):
        unit = unit[:-3] + "y"
    elif unit.endswith("es") and unit[:-2] in {"dash", "pinch", "inch"}:
        unit = unit[:-2]
    elif unit.endswith("s") and not unit.endswith("ss") and len(unit) > 3:
        unit = unit[:-1]
    return _UNIT_SPELLINGS.get(unit, unit)


def build(zip_path: Path) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        categories = {r["id"]: r["description"] for r in _rows(archive, "food_category.csv")}
        foods = {
            r["fdc_id"]: (r["description"], categories.get(r["food_category_id"], ""))
            for r in _rows(archive, "food.csv")
        }
        amounts: dict[str, dict[str, str]] = defaultdict(dict)
        for r in _rows(archive, "food_nutrient.csv"):
            if r["nutrient_id"] in NUTRIENTS:
                amounts[r["fdc_id"]][NUTRIENTS[r["nutrient_id"]]] = r["amount"]
        portions = [
            r
            for r in _rows(archive, "food_portion.csv")
            if r["fdc_id"] in foods and float(r["amount"] or 0) > 0
        ]

    kept: list[tuple[int, str, str, dict[str, str]]] = []
    incomplete: list[str] = []
    for fdc_id, (description, category) in foods.items():
        if category in EXCLUDED_CATEGORIES:
            continue
        figures = amounts.get(fdc_id, {})
        # A food missing one of the five would total as if it had none of
        # it, which is exactly the quiet undercount the app refuses to show.
        if len(figures) != len(NUTRIENTS):
            incomplete.append(description)
            continue
        kept.append((int(fdc_id), description, category, figures))
    kept.sort()
    kept_ids = {str(k[0]) for k in kept}

    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "foods.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["fdc_id", "description", "category", *NUTRIENTS.values()])
        for fdc_id, description, category, figures in kept:
            writer.writerow(
                [fdc_id, description, category, *(figures[n] for n in NUTRIENTS.values())]
            )

    written = sorted(
        (
            int(r["fdc_id"]),
            int(r["seq_num"] or 0),
            portion_unit(r["modifier"]),
            r["modifier"].strip(),
            round(float(r["gram_weight"]) / float(r["amount"]), 3),
        )
        for r in portions
        if r["fdc_id"] in kept_ids
    )
    with (OUT / "portions.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(["fdc_id", "unit", "description", "grams"])
        for fdc_id, _, unit, description, grams in written:
            writer.writerow([fdc_id, unit, description, f"{grams:g}"])

    print(f"{len(kept)} foods, {len(written)} portions written to {OUT}")
    print(f"{len(incomplete)} foods left out for missing a figure, e.g. {incomplete[:5]}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    build(Path(sys.argv[1]))
