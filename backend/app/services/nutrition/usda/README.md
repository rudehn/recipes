# USDA nutrition tables

Built from USDA FoodData Central's **SR Legacy** release (April 2018), which is in the public domain.
Do not edit these files by hand.

- `foods.csv` - calories, protein, fat, carbohydrate and sodium per 100 g, for every food that has all five.
- `portions.csv` - the kitchen measures USDA weighed for each food ("1 cup, chopped", "1 clove", "1 large"), in grams for one of the unit.

Categories that are not ingredients are left out: baby food, fast food and restaurant meals, prepared entrees, branded products, and USDA's laboratory controls.

## Rebuilding

Download "SR Legacy" as CSV from https://fdc.nal.usda.gov/download-datasets, then from `backend/`:

```sh
uv run python scripts/build_nutrition_data.py FoodData_Central_sr_legacy_food_csv_2018-04.zip
```

SR Legacy is frozen, so the output only changes when the script does.
Both files are sorted, and a rebuild that changes nothing diffs as nothing.

Food ids are USDA's `fdc_id`, and `services/nutrition/defaults.py` and the `ingredient_food_matches` table both refer to them.
A rebuild that dropped a food would leave those pointing at nothing, which the app reports as "no food chosen" rather than failing.
