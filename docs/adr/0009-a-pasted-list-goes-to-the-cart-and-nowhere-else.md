# 9. A pasted list goes to the cart and nowhere else

Accepted, September 2026.

## Context

Not everything bought at Kroger comes from a planned recipe.
Milk, paper towels and whatever a partner texted over are kept in Notes, Reminders or a message, and until now the only way to get them into the cart was to type them into kroger.com by hand.

The first design put pasted lines onto the grocery list: merged by key with recipe lines, tied to the trip, cleared or carried over by "Start a new trip", and weighed against the pantry.
Each of those raised a question with no clean answer, such as what a pasted "eggs" does to a recipe's "3 eggs", or whether pasting a pantry staple should mark it out of stock.
None of it was what the feature is for.

## Decision

**Pasted text is read, reviewed and sent to the cart, and nothing is stored.**
`POST /api/cart/paste/preview` reads the text and says what it would order, line by line.
`POST /api/cart/paste/add` reads the same text again, plans again, and sends.
The grocery list, the planner, the pantry and the trip's marks are never touched.

**It shares the cart's rules, not the list's state.**
- The review is required, because the cart is write-only (ADR 4).
- Products and counts come from one function, `cart._order`, which the grocery list's send uses too.
- A send records `kroger_cart_sent_at`, since it is the same cart and a second send adds to it.
- It does not write `CartSentLine`. Pasting "eggs" says nothing about the eggs the week's meals need, so it must not stop them from being sent.
- A product chosen in the review is remembered by `canonical_key`, like every other choice (ADR 2).

**A bare number is packages.**
On a shopping list, "2 eggs" is two cartons, not two eggs.
A number alone, or a number of containers ("3 cans"), is a count of packages and is sent as it stands.
Only a real measure ("2 lb ground beef", "1 gallon milk") is sized against the package, the way a recipe's amount is.

**Any department, food first.**
A shopping list has paper towels on it, and the matcher rejects non-food departments for recipes.
Pasted lines seen for the first time may match outside the food aisles, but only after no food product answered, so "salt" is still the salt in the baking aisle and not the Epsom salt in the pharmacy.

**Lines stay in place.**
A line that cannot be ordered is shown where it was pasted, with the reason and a way to choose a product, because the review is the only place a pasted line can be put right.
A line taken off stays too, struck through, with "Put back".
Lines already ticked in the paste are left out and named.

## Why

The cart is where the pasted list was always going.
Holding it on the grocery list first would have added storage, a lifetime, merge rules and pantry rules, all to serve a detour.
Keeping it out of the list's state also keeps every earlier decision about the list intact: ADR 5's marks still mean one trip, and ADR 4's hold-back of lines already sent still guards only the list it was built for.

## Consequences

- Nothing warns that a pasted item was also sent from the grocery list.
  The "last sent" note on the cart section is the only guard, the same one that already covers two separate sends.
- A key first matched from a paste may be a non-food product, and a recipe with the same key would then use it.
  For the keys a paste is likely to introduce ("paper towels", "dish soap") no recipe has the same key, and the choice can be changed like any other.
- Kroger's public Cart API cannot read the cart, so the review cannot say what is already in it.
