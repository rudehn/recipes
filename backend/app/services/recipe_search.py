"""Finds candidate recipes across a curated set of cooking sites.

Rather than going through a search engine, we ask each site for its own search
results in parallel, then run the resulting URLs through the same parser the
URL importer uses. That keeps the feature key-free and keeps us on publicly
exposed endpoints of sites we have explicitly vetted, instead of crawling the
open web.

Most of the allowlist runs WordPress and answers on ``/wp-json/wp/v2/search``.
Sites that do not need their own strategy, so each ``Site`` carries the
function that searches it.

Sites earn a place on the allowlist by publishing schema.org/Recipe JSON-LD;
one that does not (Smitten Kitchen, for instance) can be searched but never
parsed, so it is left off rather than shipped as a permanent failure.

What each site considers a match is looser than what a person does, so their
ranking is treated as a nomination rather than an answer: candidates are
re-ranked here against the query, and ones that only brushed against it are
dropped. See ``relevance``."""

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from html import unescape
from urllib.parse import urlsplit

import httpx
from bs4 import BeautifulSoup

from ..schemas import RecipeDraft
from .fetch import BROWSER_HEADERS
from .recipe_import import RecipeNotFound, parse_recipe_html
from .relevance import (
    MIN_RELEVANCE,
    WEAK_RELEVANCE,
    query_terms,
    score_draft,
    score_title,
)


@dataclass(frozen=True)
class Candidate:
    """A search hit before it is fetched: everything we know about a result
    without paying for the page. The title is what lets us rank candidates
    before deciding which are worth fetching."""

    url: str
    title: str = ""


log = logging.getLogger(__name__)

SearchFn = Callable[[httpx.AsyncClient, "Site", str], Awaitable[list[Candidate]]]


async def _search_wordpress(
    client: httpx.AsyncClient, site: "Site", query: str
) -> list[Candidate]:
    """Results from a site's WordPress search API."""
    resp = await client.get(
        f"{site.base}/wp-json/wp/v2/search",
        params={"search": query, "per_page": RESULTS_PER_SITE, "subtype": "post"},
        timeout=SEARCH_TIMEOUT,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, list):
        return []
    return [
        Candidate(item["url"], _plain_text(item.get("title")))
        for item in payload
        if isinstance(item, dict) and isinstance(item.get("url"), str)
    ]


_TAG = re.compile(r"<[^>]+>")


def _plain_text(value: object) -> str:
    """WordPress renders titles for display: entity-escaped, sometimes with
    markup in them. Scoring wants the words."""
    if not isinstance(value, str):
        return ""
    return unescape(_TAG.sub(" ", value)).strip()


# Individual AllRecipes recipes always live at /recipe/<id>/<slug>. Matching
# the URL rather than the markup keeps this clear of their generated CSS
# class names, which change far more often than the URL scheme does.
ALLRECIPES_URL = re.compile(r"^https://www\.allrecipes\.com/recipe/\d+/")


async def _search_allrecipes(
    client: httpx.AsyncClient, site: "Site", query: str
) -> list[Candidate]:
    """Results scraped from the AllRecipes search page.

    AllRecipes is not WordPress and exposes no search API, so we read the
    same results page a visitor would and keep the recipe links."""
    resp = await client.get(
        f"{site.base}/search", params={"q": query}, timeout=SEARCH_TIMEOUT
    )
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    found: list[Candidate] = []
    seen: set[str] = set()
    for anchor in soup.find_all("a", href=True):
        href = anchor["href"].split("?")[0]
        if ALLRECIPES_URL.match(href) and href not in seen:
            seen.add(href)
            found.append(Candidate(href, anchor.get_text(" ", strip=True)))
            if len(found) == RESULTS_PER_SITE:
                break
    return found


@dataclass(frozen=True)
class Site:
    label: str
    base: str
    search: SearchFn = field(default=_search_wordpress)


ALLOWLIST: tuple[Site, ...] = (
    Site("Budget Bytes", "https://www.budgetbytes.com"),
    Site("Cookie and Kate", "https://cookieandkate.com"),
    Site("Minimalist Baker", "https://minimalistbaker.com"),
    Site("Half Baked Harvest", "https://www.halfbakedharvest.com"),
    Site("The Woks of Life", "https://thewoksoflife.com"),
    Site("Pinch of Yum", "https://pinchofyum.com"),
    Site("AllRecipes", "https://www.allrecipes.com", search=_search_allrecipes),
)

# How many results to ask each site for. Far more than we intend to show,
# because a site's own top hit is often the weakest of the ones it could have
# offered: asking wide and ranking ourselves is what lets a good sixth result
# from one site beat a mediocre first from another. It costs one request per
# site either way, so this is nearly free - and measuring across queries, the
# returns flatten here. Past 8, the candidates a site adds are ones the
# ranking never chooses to fetch.
RESULTS_PER_SITE = 8

# Ceiling on pages fetched per search, and the one number here that is
# expensive: each is a full recipe page, and raising it by 8 costs about a
# second and a half on every search to fill out the occasional thin one.
# Candidates are ranked on their titles first, so the budget is spent on the
# most promising ones rather than the first ones. Set above MAX_RESULTS to
# leave room for pages that fail to parse or turn out, once read, to be
# irrelevant.
MAX_FETCHES = 16

MAX_RESULTS = 12

# Below this many confident matches there is nothing to compare, which is when
# near misses are worth showing. See the tail of ``search_recipes``.
MIN_RESULTS = 3

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


async def _search_site(
    client: httpx.AsyncClient, site: Site, query: str
) -> list[Candidate]:
    """Hits from one site's search. Never raises: a site being down or having
    changed its search should cost us that site, not the whole search.

    Swallowing the failure is right, staying quiet about it is not. A site can
    drop off the allowlist for good - blocked, moved, or no longer answering
    the endpoint we know - and the results simply get thinner, which looks
    exactly like a query with fewer matches. This log line is the only place
    that difference is visible."""
    try:
        return await site.search(client, site, query)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("%s search failed for %r: %s", site.label, query, exc)
        return []


async def _fetch_draft(client: httpx.AsyncClient, url: str) -> RecipeDraft | None:
    """Parsed recipe at ``url``, or None if it cannot be read as one. Pages
    that fail are dropped silently; partial results beat an error page."""
    try:
        resp = await client.get(url, timeout=FETCH_TIMEOUT)
        resp.raise_for_status()
    except httpx.HTTPError:
        return None
    try:
        draft = parse_recipe_html(resp.text, url)
    except RecipeNotFound:
        return None
    draft.source_label = site_label(url)
    return draft


def _interleave(per_site: Sequence[Sequence[Candidate]]) -> list[Candidate]:
    """One round-robin pass over each site's results, deduplicated.

    Interleaving is the tie-break the ranking inherits: sorting is stable, so
    candidates that score the same stay in this order and the top of the list
    spans several sources instead of one prolific site."""
    ordered: list[Candidate] = []
    seen: set[str] = set()
    for rank in range(RESULTS_PER_SITE):
        for results in per_site:
            if rank < len(results) and results[rank].url not in seen:
                seen.add(results[rank].url)
                ordered.append(results[rank])
    return ordered


async def search_recipes(query: str, limit: int = MAX_RESULTS) -> list[RecipeDraft]:
    """Drafts for ``query`` gathered across the allowlist, most relevant first.

    Ranking happens twice, because the two stages know different things. Before
    fetching, all we have is a title, and it decides which candidates are worth
    a round trip. After fetching we have the recipe itself, and the score is
    recomputed over its description and ingredients to order what is shown and
    to drop anything that turned out not to be about the query at all.

    Results are unsaved: the caller previews them and picks one."""
    terms = query_terms(query)
    # Nothing to match on - punctuation, say. Every result would score zero, so
    # the sites are spared a search whose outcome is already known.
    if not terms:
        return []

    async with httpx.AsyncClient(
        follow_redirects=True, headers=BROWSER_HEADERS, timeout=FETCH_TIMEOUT
    ) as client:
        per_site = await asyncio.gather(
            *(_search_site(client, site, query) for site in ALLOWLIST)
        )

        candidates = _interleave(per_site)
        candidates.sort(key=lambda c: score_title(terms, c.title, c.url), reverse=True)
        candidates = candidates[:MAX_FETCHES]

        gate = asyncio.Semaphore(MAX_CONCURRENT_FETCHES)

        async def guarded(candidate: Candidate) -> RecipeDraft | None:
            async with gate:
                return await _fetch_draft(client, candidate.url)

        drafts = await asyncio.gather(*(guarded(c) for c in candidates))

    scored = [(score_draft(terms, d), d) for d in drafts if d is not None]
    scored.sort(key=lambda pair: pair[0], reverse=True)

    confident = [draft for score, draft in scored if score >= MIN_RELEVANCE]
    if len(confident) >= MIN_RESULTS:
        return confident[:limit]

    # Too few to compare, which for a niche dish usually means the wording is
    # unusual rather than that nothing was found. Top the list up with the
    # best of the near misses - and if there are none of those either, say so
    # rather than filling the page with recipes about something else.
    return [draft for score, draft in scored if score >= WEAK_RELEVANCE][:MIN_RESULTS]
