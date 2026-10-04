"""When two links are the same recipe, and what of a link is worth keeping.

The point is noticing a recipe that is already in the box before it is
imported a second time, so the cases are the ways one page's link really
arrives: shared with tracking junk, typed without "www.", copied from an old
http bookmark, or pasted with a jump-to-recipe anchor on the end. Some sites
name the page in the query string instead of the path, so only the tracking
part of a query is noise.
"""

import pytest

from app.services.recipe_source import source_key, without_tracking

CHILI = "https://www.budgetbytes.com/one-pot-chili/"

# A WordPress site without pretty permalinks, where the query is the page.
POST = "https://example.com/?p=123"


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
    "key",
    [
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "utm_id",
        # A campaign tool's own utm_ is still campaign tagging.
        "utm_pinterest_board",
        "UTM_Source",
        "fbclid",
        "gclid",
        "dclid",
        "gbraid",
        "wbraid",
        "msclkid",
        "yclid",
        "twclid",
        "ttclid",
        "li_fat_id",
        "epik",
        "mc_cid",
        "mc_eid",
        "_hsenc",
        "_hsmi",
        "mkt_tok",
        "igshid",
        "igsh",
        "_ga",
        "_gl",
        "ref",
        "ref_src",
    ],
)
def test_tracking_parameters_do_not_tell_pages_apart(key):
    assert source_key(f"{CHILI}?{key}=abc123") == source_key(CHILI)
    assert source_key(f"{POST}&{key}=abc123") == source_key(POST)


def test_the_order_of_the_parameters_that_matter_does_not_count():
    assert source_key("https://example.com/recipe?id=45&lang=en") == source_key(
        "https://example.com/recipe/?lang=en&utm_source=x&id=45"
    )


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


@pytest.mark.parametrize(
    "other",
    [
        "https://example.com/?p=124",
        "https://example.com/",
        "https://example.com/?recipe=123",
        "https://example.com/?p=123&print=1",
    ],
)
def test_a_page_named_by_its_query_is_not_confused_with_another(other):
    assert source_key(other) != source_key(POST)


@pytest.mark.parametrize(
    ("given", "kept"),
    [
        (
            "https://www.budgetbytes.com/one-pot-chili/?utm_source=pinterest&utm_medium=social",
            "https://www.budgetbytes.com/one-pot-chili/",
        ),
        (
            "https://www.budgetbytes.com/one-pot-chili/?fbclid=IwAR0abc",
            "https://www.budgetbytes.com/one-pot-chili/",
        ),
        # What identifies the page stays, in its own order and spelling, and
        # so does the anchor the link was shared with.
        (
            "https://example.com/recipe/?p=123&utm_source=x&lang=en%20GB#step-3",
            "https://example.com/recipe/?p=123&lang=en%20GB#step-3",
        ),
        (
            "https://www.budgetbytes.com/one-pot-chili/?utm_campaign=x#wprm-recipe-container",
            "https://www.budgetbytes.com/one-pot-chili/#wprm-recipe-container",
        ),
        ("https://example.com/r?ref&id=7", "https://example.com/r?id=7"),
        ("https://example.com/r?UTM_Source=x&id=7", "https://example.com/r?id=7"),
        # A tracking key's name inside a value is just a value.
        ("https://example.com/search?q=utm_source", "https://example.com/search?q=utm_source"),
    ],
)
def test_a_link_keeps_everything_but_its_tracking(given, kept):
    assert without_tracking(given) == kept


def test_a_link_without_tracking_is_kept_exactly_as_given():
    """Matching ignores the host's case, the scheme and the trailing slash,
    but the link itself is not rewritten for them."""
    link = "http://WWW.Example.com/Chili?b=2&a=1#notes"
    assert without_tracking(link) == link
