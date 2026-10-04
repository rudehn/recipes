"""Where a recipe came from, and whether that page is already in the box.

A link to one recipe page arrives in more than one spelling. Shared from a
phone it carries tracking parameters; typed from memory it lacks "www.";
copied from an old bookmark it is http; followed from a "jump to recipe"
button it ends in an anchor. The importer would read every one of them as a
new recipe, so before a draft is offered for saving it is checked against the
links already saved, and the page can say "already in your box" instead.
"""

from collections.abc import Sequence
from urllib.parse import urlsplit

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Recipe
from ..schemas import RecipeDraft


def bare_host(url: str) -> str:
    """The site a link points at, lowercased and without a leading "www.".

    The search allowlist names sites by this too, so a link typed with
    "WWW.BudgetBytes.com" is still Budget Bytes.
    """
    return (urlsplit(url).hostname or "").removeprefix("www.")


def source_key(url: str) -> str:
    """What two links to the same recipe page have in common.

    Kept: the host and the path, which together are the page. Dropped:
    the scheme, since a site serves the same page on http and https; a
    leading "www.", which is the same site; the query string, which on a
    recipe page is tracking ("utm_source", "fbclid") rather than content;
    the fragment, which only scrolls; and a trailing slash, which WordPress
    adds and people leave off. The path keeps its case, since a server may
    tell "/Chili" from "/chili" even though no host is told apart by case.
    """
    parts = urlsplit(url)
    return bare_host(url) + parts.path.rstrip("/")


async def mark_already_saved(session: AsyncSession, drafts: Sequence[RecipeDraft]) -> None:
    """Point each draft at the saved recipe imported from the same page.

    The keys are worked out here, on every call, rather than stored in an
    indexed column beside each link. A stored key is a second copy of the
    link that every change to `source_key` turns stale, so improving the
    match would need a data migration each time - the cost ADR 2 records for
    the grocery key. Working it out costs one read of the saved links, which
    for one household's box is a few hundred short strings against an import
    or a search that has already spent seconds fetching pages. If the box
    ever grows to where that read shows, this is the one function to change.

    Where a page was saved twice the older recipe is the one named, so the
    answer does not move when another copy is made.
    """
    if not drafts:
        return
    result = await session.execute(
        select(Recipe.id, Recipe.source_url)
        .where(Recipe.source_url.is_not(None))
        .order_by(Recipe.id)
    )
    saved: dict[str, int] = {}
    for recipe_id, url in result.all():
        saved.setdefault(source_key(url), recipe_id)
    for draft in drafts:
        draft.saved_recipe_id = saved.get(source_key(draft.source_url))
