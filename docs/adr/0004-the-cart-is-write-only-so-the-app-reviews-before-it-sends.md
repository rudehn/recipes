# 4. The cart is write-only, so the app reviews before it sends

Accepted, August 2026.

## Context

Kroger's Cart API has one operation: `PUT /v1/cart/add`.

There is no read, no remove, and no replace.
The app cannot ask what is in the cart, cannot tell whether a previous send landed, and cannot take anything back out.
Sending the same list twice orders two of everything, and the only place that is visible is kroger.com.

This is unlike every other write in the app.
A grocery checkmark can be unticked, a meal plan entry deleted, a bad product match corrected.
Those can afford to be optimistic, and the grocery list is deliberately optimistic - it keeps a checkmark a failed request never saved, because the shopper really did put the thing in the trolley.

None of that reasoning survives contact with an operation that cannot be undone.

## Decision

Ordering is a two-step flow: `GET /api/cart/preview` says exactly what would be sent, and `POST /api/cart/add` sends it.
Nothing reaches Kroger without the preview having been rendered.

Alongside that:

- The preview carries quantities, not just products.
- Lines that cannot be ordered are named, not counted.
- The send re-plans server-side rather than trusting the preview, and reports what it actually sent.
- `kroger_cart_sent_at` is recorded, and the page says when a list last went.
- After a send, the app links to kroger.com rather than describing the cart.

## Why

**A quantity is as irreversible as a product, and less expected.**
A week of bread is three five-pound bags of flour, worked out from the meal plan.
That is the right answer and it is also the kind of answer worth seeing before it is bought.
The same arithmetic sits behind the price already on screen, so hiding it in the cart step would mean the one number that becomes a real order is the one nobody saw.

**"2 not sent" is not something you can shop from.**
A count tells a shopper that something is missing without telling them what, at the exact moment they still could have written it down.
Names cost the same to render.

**A preview minutes old describes a different trip.**
Products go out of stock, and checkmarks get ticked while the review is open.
So the server plans again as it sends and answers with what it did, and the page reports the server's number rather than the one it had on screen.
The client-side review is keyed on the checkmarks for the same reason: changing them starts the review over rather than leaving it stale.

**The app must not claim to know what is in a cart it cannot see.**
A "sent" state is a fact about this app's request, not about the cart.
So the confirmation says how many were added and points at Kroger, and the warning about a second send says it *adds to* that cart rather than replacing it - which is what actually happens.

## What this rules out

**Optimistic sending.** Nothing to roll back to.

**Retrying a failed send automatically.**
A request that timed out may or may not have landed, and there is no way to find out.
The failure is reported, and re-sending is the shopper's decision with the last-sent time in front of them.

**Syncing the cart.**
Tempting, and impossible: there is no read.
An app that showed "in your cart" beside a grocery line would be showing what it once sent, which diverges the first time anyone edits the cart on kroger.com.

## Consequences

- Ordering costs one extra round trip and one extra Kroger product lookup, against a 5,000/day cart allowance and a 10,000/day products one.
- The preview is fetched only when the review is opened, so a grocery page that is merely being read costs nothing.
- The two-step flow is one more tap than a single button.
  That is the price of the guarantee, and it is the right way round for an action with no undo.
