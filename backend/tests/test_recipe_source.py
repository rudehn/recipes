"""When two links are the same recipe.

The point is noticing a recipe that is already in the box before it is
imported a second time, so the cases are the ways one page's link really
arrives: shared with tracking junk, typed without "www.", copied from an old
http bookmark, or pasted with a jump-to-recipe anchor on the end.
"""

import pytest

from app.services.recipe_source import source_key

CHILI = "https://www.budgetbytes.com/one-pot-chili/"


@pytest.mark.parametrize(
    "variant",
    [
        CHILI,
        "https://www.budgetbytes.com/one-pot-chili",
        "https://budgetbytes.com/one-pot-chili/",
        "http://www.budgetbytes.com/one-pot-chili/",
        "https://WWW.BudgetBytes.com/one-pot-chili/",
        "https://www.budgetbytes.com/one-pot-chili/?utm_source=pinterest&utm_medium=social",
        "https://www.budgetbytes.com/one-pot-chili/#wprm-recipe-container-12345",
        "https://www.budgetbytes.com/one-pot-chili/?fbclid=abc#comments",
    ],
)
def test_one_recipe_has_one_key_however_its_link_arrives(variant):
    assert source_key(variant) == source_key(CHILI)


@pytest.mark.parametrize(
    "other",
    [
        # Another recipe on the same site.
        "https://www.budgetbytes.com/one-pot-chili-mac/",
        # The same slug on another site is another site's recipe.
        "https://pinchofyum.com/one-pot-chili/",
        # A path is case-sensitive on the server, unlike a host.
        "https://www.budgetbytes.com/One-Pot-Chili/",
        # Only a leading "www." is noise; any other subdomain is a site.
        "https://blog.budgetbytes.com/one-pot-chili/",
    ],
)
def test_different_recipes_keep_different_keys(other):
    assert source_key(other) != source_key(CHILI)
