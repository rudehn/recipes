"""Finds candidate recipes across a curated set of cooking sites.

Rather than going through a search engine, we query each site's own public
WordPress search API (``/wp-json/wp/v2/search``) in parallel, then run the
resulting URLs through the same parser the URL importer uses. That keeps the
feature key-free and keeps us on documented, publicly exposed endpoints of
sites we have explicitly vetted, instead of crawling the open web.

Sites earn a place on the allowlist by publishing schema.org/Recipe JSON-LD;
one that does not (Smitten Kitchen, for instance) can be searched but never
parsed, so it is left off rather than shipped as a permanent failure."""

import asyncio
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from ..schemas import RecipeDraft
from .fetch import BROWSER_HEADERS
from .recipe_import import RecipeNotFound, parse_recipe_html


@dataclass(frozen=True)
class Site:
    label: str
    base: str


ALLOWLIST: tuple[Site, ...] = (
    Site("Budget Bytes", "https://www.budgetbytes.com"),
    Site("Cookie and Kate", "https://cookieandkate.com"),
    Site("Minimalist Baker", "https://minimalistbaker.com"),
    Site("Half Baked Harvest", "https://www.halfbakedharvest.com"),
    Site("The Woks of Life", "https://thewoksoflife.com"),
    Site("Pinch of Yum", "https://pinchofyum.com"),
)

# Per-site result cap. Small on purpose: the point is a handful of options to
# compare side by side, not an exhaustive list to wade through.
RESULTS_PER_SITE = 2
MAX_RESULTS = 12

# Recipe pages are heavy; these bound the worst case rather than the norm.
SEARCH_TIMEOUT = 8.0
FETCH_TIMEOUT = 15.0
MAX_CONCURRENT_FETCHES = 8


def site_label(url: str) -> str:
    """Human-readable source for a result URL, for the comparison tabs."""
    host = urlsplit(url).netloc.removeprefix("www.")
    for site in ALLOWLIST:
        if urlsplit(site.base).netloc.removeprefix("www.") == host:
            return site.label
    return host


async def _search_site(client: httpx.AsyncClient, site: Site, query: str) -> list[str]:
    """URLs from one site's search API. Never raises: a site being down or
    having changed its API should cost us that site, not the whole search."""
    try:
        resp = await client.get(
            f"{site.base}/wp-json/wp/v2/search",
            params={"search": query, "per_page": RESULTS_PER_SITE, "subtype": "post"},
            timeout=SEARCH_TIMEOUT,
        )
        resp.raise_for_status()
        payload = resp.json()
    except (httpx.HTTPError, ValueError):
        return []
    if not isinstance(payload, list):
        return []
    return [
        item["url"]
        for item in payload
        if isinstance(item, dict) and isinstance(item.get("url"), str)
    ]


async def _fetch_draft(client: httpx.AsyncClient, url: str) -> RecipeDraft | None:
    """Parsed recipe at ``url``, or None if it cannot be read as one. Pages
    that fail are dropped silently; partial results beat an error page."""
    try:
        resp = await client.get(url, timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPError:
        return None
    try:
        return parse_recipe_html(resp.text, url)
    except RecipeNotFound:
        return None


async def search_recipes(query: str, limit: int = MAX_RESULTS) -> list[RecipeDraft]:
    """Drafts for ``query`` gathered across the allowlist, best first.

    Results are unsaved: the caller previews them and picks one."""
    async with httpx.AsyncClient(
        follow_redirects=True, headers=BROWSER_HEADERS, timeout=FETCH_TIMEOUT
    ) as client:
        per_site = await asyncio.gather(
            *(_search_site(client, site, query) for site in ALLOWLIST)
        )

        # Interleave sites so one prolific site cannot crowd out the rest, and
        # the first tabs the user sees span several sources.
        urls: list[str] = []
        seen: set[str] = set()
        for rank in range(RESULTS_PER_SITE):
            for results in per_site:
                if rank < len(results) and results[rank] not in seen:
                    seen.add(results[rank])
                    urls.append(results[rank])
        urls = urls[:limit]

        gate = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)

        async def guarded(url: str) -> RecipeDraft | None:
            async with gate:
                return await _fetch_draft(client, url)

        drafts = await asyncio.gather(*(guarded(url) for url in urls))

    return [draft for draft in drafts if draft is not None]
