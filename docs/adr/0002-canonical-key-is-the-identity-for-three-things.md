# 2. `canonical_key` is the identity for three separate things

Accepted, August 2026.

## Context

`services/canonical.py::canonical_key` reduces an ingredient name to what you would actually buy.
"Large eggs, at room temperature" becomes `egg`; "onion (small dice, (265 g, 2 cups) $0.72)" becomes `onion`.

It was written for one job - merging ingredients across recipes, so the grocery list says "3 cups flour" rather than listing flour three times.
It has since acquired two more:

1. The merge key for the grocery list.
2. The primary key of `grocery_checks`, so a tick survives regenerating the list.
3. Half the primary key of `ingredient_product_matches`, so an ingredient keeps meaning the same Kroger product.

## Decision

Keep one key for all three, deliberately, rather than introducing a separate identity for product matching.

## Why

The three questions are the same question.
"Are these the same thing to buy?" is what the merge asks, what a checkmark records, and what a product match answers.
Splitting the key would mean maintaining two notions of sameness that must never disagree, which is worse than one notion that is occasionally wrong.

It also keeps the correction path honest.
Fixing a match fixes it everywhere the ingredient appears, because there is only one place it can be recorded.

## Consequences

**Changing canonicalisation invalidates stored state.**
This is the real cost, and it is not hypothetical - it happened twice while building pricing.

- Teaching `clean_display` about nested brackets moved `onion (small dice, (265 g, 2 cups) $0.72)` from the key `onion-0-72` to `onion`.
- Folding accents moved `jalapeño` from `jalape-o` to `jalapeno`.

Both were fixes to genuinely broken keys, and both silently orphaned any checkmarks and product matches recorded under the old spelling.
Nothing broke loudly.
The rows simply stopped being found, and matches re-resolved on the next page load.

So: **a change to `canonical_key` is a data migration, whether or not it comes with one.**
For a single-user app the orphaned rows are cheap - a re-tick and a re-resolve.
If this ever holds more than one household's data, that stops being true and the change needs a backfill.

**Tests exist to make this visible.**
`tests/test_canonical.py` covers the merge behaviour, and any change that moves a key should be expected to move tests with it.
If it does not, the change is probably not doing what its author thinks.
