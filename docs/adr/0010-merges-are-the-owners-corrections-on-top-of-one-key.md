# 10. Merges are the owner's corrections on top of one key

Accepted, October 2026.

## Context

ADR 2 made `canonical_key` the one identity for "is this the same thing to buy".
It cannot know that "ground cumin" and "cumin" are the same thing, or "mayo" and "mayonnaise", and the real recipe box had about ten such pairs among 92 ingredients.
Each pair cost something: two grocery lines, a staple that did not cover its own spice, and two remembered products for one jar.

## Decision

The owner merges two names, and the merge is stored as a row (`ingredient_merges`) rather than written into recipe text.
`services.identity` applies `canonical_key` and then the merges, and is the only way ingredients are compared; a test fails if code calls the key functions directly.
A merge moves what was decided about the merged-away name to the target in the same transaction: products at every store, foods, staples, this trip's ticks and cart lines.
A hand pick beats an automatic one, and two different hand picks, or two staples, need the owner's choice.
Unmerging deletes the row and nothing else.

## Why

**One notion of sameness, corrected.**
ADR 2's argument holds: two keys that must never disagree are worse than one that is occasionally wrong.
A merge does not add a second notion; it corrects the one there is, in the one place it is read.

**Recipe text is the author's.**
"2 tsp ground cumin" is what the cook reads at the stove, and a merge that rewrote it would be impossible to undo and would split again on the next import.

**Never guessed.**
Merges are suggested, never applied, for the reason ADR 8 gives for foods: a wrong merge is plausible and invisible, while a missing one is only untidy.

## Consequences

- A change to `canonical_key` still invalidates stored state, merges included: a merge whose `from_key` no longer occurs is inert, and one whose `to_key` moved needs the same migration that moves the rest.
- The merges table is read once per database session, so one request reads it once.
- An unmerged name loses what moved to the target; the unmerge confirmation says so.
