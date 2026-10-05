# Mise

The words this codebase uses for its domain, and what they mean here.

## Ingredients

**Ingredient**: what a recipe line or a staple stands for, identified by its key after merges (`services.identity`).
"2 large eggs" and "eggs, beaten" are one ingredient, `egg`.
Avoid: item, product (a product is what a store sells).

**Staple**: an ingredient the household keeps in stock, recorded as a pantry item with an in-stock flag.
Avoid: pantry item, in user-facing text.

**Merge**: the owner saying two names are one ingredient, stored apart from recipe text and reversible (ADR 10).

**Suggested merge**: a pair the app thinks might be one ingredient, offered for the owner to merge or turn down, never applied by itself.
