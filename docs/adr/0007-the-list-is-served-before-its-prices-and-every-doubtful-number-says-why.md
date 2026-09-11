# 7. The list is served before its prices, and every doubtful number says why

Accepted, September 2026.

## Context

A real week's list of 72 lines took 3 seconds to load and 1.7 seconds to reload, and every tick in the aisle reloaded it.
A Kroger call costs 0.6 to 0.8 seconds however small, and the list made its calls one after another: two price batches in sequence, and a search per ingredient nothing had matched yet, also in sequence.
Ten unseen ingredients measured 8.5 seconds sequentially against 1.2 seconds together.

Separately, the same list showed why a number was doubtful in only one case, "no match".
An avocado saved as `Optional: 1 diced ripe avocado` had its amount inside its name, scaled to nothing, and ordered one; nine cups of corn against a 10 oz can had no density to relate them and ordered one can.
Neither said so.

## Decision

**Two requests.**
`GET /grocery-list` is served from the database alone and makes no Kroger call.
`GET /grocery-list/prices` is fetched second and lays prices over the list by key.
The page shows what to buy at once, and the total fills in when Kroger answers.

**Concurrent calls.**
Price batches go out together, and searches for unseen ingredients go out together under a cap of six.

**A short memory of prices.**
A product's price is kept in memory for ten minutes per store.
A reload within that window costs no Kroger call, so a tick in the aisle is answered from the database.
This is a cache of the last answer and dies with the process; it is not the price history Kroger's terms forbid, which would be prices kept over time to compare against.

**One vocabulary for why a number is doubtful.**
`LineIssue` names six reasons, most serious first: the amount is in the name, there is no amount, the row is not an ingredient, nothing matched, the amount cannot be sized against the package, the shelf is empty today.
The first three are the recipe's and are found by `services.lint` from the rows alone; the list carries them without a store.
The last three are the product's and ride on the prices.
A line shows the first that applies, in the price column, in the cart review, and in the summary's shortfall ("8 not matched · 5 need a look").
The recipe page shows the same reason on the row, and the recipes page groups them under "Needs a look".

**The importer reads past labels and keeps the line.**
"Optional:" and "For the sauce:" are read past so the amount is found; a bare package size after the amount is read as such; a mixed number is a whole and a fraction, never two wholes.
Every imported row keeps its original line, so a better parser can be run over it later.
Rows already saved with the amount inside the name were re-read once by migration, and their remembered products followed them to their new keys.

## Why

**The list is the product and prices are the garnish.**
That was already the rule for failures (ADR 1's consequences, `pricing.attach_prices`); it is now the rule for time too.
A page that cannot show what to buy until a third party answers has the priority backwards.

**Naming the reason is cheaper than hiding it and far cheaper than guessing.**
Every check is a string check over data the list already holds, so it costs nothing on load.
A count of one that reads like a worked-out count is trusted; a count of one that says "can't size 9 cups against 10 oz" is checked.

**The fix belongs where the fault is.**
Half the reasons are the recipe's.
Showing them on the shopping page with a link to the recipe row, and on the recipe row itself, means the shopper never has to know which page owns the problem.

## Consequences

- The grocery page makes two requests where it made one; the second is usually answered in under 50 ms from memory.
- The first load after a deploy of new matching rules is still slow once, since every automatic match is remade; it is now six at a time rather than one.
- `test_grocery_pricing.fetch` merges the two responses the way the page does, so tests still read like a priced list.
- A vegetable section joined the density table, starting with corn.
