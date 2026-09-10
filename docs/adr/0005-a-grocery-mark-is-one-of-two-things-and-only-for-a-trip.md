# 5. A grocery mark is one of two things, and only for a trip

Accepted, September 2026.

## Context

A grocery line could carry one mark: the tick.
It meant "in the trolley" - struck through, still counted in the estimate, left out of the Kroger cart.

There was no way to say the other thing a shopper says to a list, that there is already enough of it at home.
People ticked those lines too, which kept them in the estimate, and the next "clear checkmarks" brought them back.
Sending the list to Kroger with such a line unticked ordered more of something already on the counter, and the cart cannot be asked to take it back.

## Decision

A line carries a status of `to_buy`, `bought`, or `have`, stored as one row per line in `grocery_checks` while either mark applies.

- `bought` is the tick. Struck through, still paid for, not ordered.
- `have` is set aside. Dimmed, not struck through, left out of the estimate and the cart, still priced.
- Both are cleared together by "Start a new trip".

A `have` mark on a pantry-tracked line restocks the pantry item, the way a tick already did.

## Why

**Two answers to one question share one row.**
"Does this still need buying?" has three answers, and a line cannot be both in the trolley and left at home.
Two booleans could disagree; one status cannot.
This is the same reasoning as ADR 2, applied to a column rather than a key.

**"Have it" is not a pantry entry.**
The pantry is for staples, and "in stock" there is a standing fact.
Avocados on the counter this week say nothing about next week's list, and a pantry that recorded them would quietly set aside next week's avocados forever.
So the mark lives with the tick and dies with it.

**Set-aside lines stay in place and stay priced.**
A row that moves the moment it is tapped cannot be un-tapped, and a line reading "no match" because it was set aside would be a lie about the matching.
Only the total is particular about which lines it counts, and the heading says how many were set aside so nothing is hidden without saying so.

## Consequences

- The estimate's coverage is quoted against the lines being bought, not the lines on screen.
- The Kroger cart review is keyed on both marks, so changing either restarts it.
- The migration turned the boolean into the status, dropping unticked rows on the way: an unticked row said nothing the absence of one does not.
