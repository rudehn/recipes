"""Nutrition per serving, worked out from a recipe's own ingredients.

`foods` holds USDA's figures, bundled. `defaults` says which food an
ingredient means when nobody has chosen one. `weights` turns an amount into
grams of that food. `facts` puts them together for a recipe, and refuses to
give a figure it cannot stand behind.
"""
