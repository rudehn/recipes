import httpx
import pytest

from app.services.recipe_import import _parse_instructions, _parse_servings
from app.services.recipe_search import (
    ALLOWLIST,
    MAX_FETCHES,
    RESULTS_PER_SITE,
    _search_allrecipes,
    _search_wordpress,
    search_recipes,
    site_label,
)
from tests.test_import import SAMPLE_HTML


def _recipe_html(title: str, description: str = "", mentions: str = "") -> str:
    """The sample recipe page retitled, and optionally given a description or a
    passing mention buried in its steps."""
    html = SAMPLE_HTML.replace("Classic <b>Banana</b> Bread", title)
    if description:
        html = html.replace("Moist and easy.", description)
    if mentions:
        html = html.replace("Mash the bananas.", f"Mash the bananas. {mentions}")
    return html


def _allrecipes_search_html(urls: list[str]) -> str:
    """An AllRecipes results page: recipe cards among the site chrome that
    surrounds them, so the extractor has to be selective."""
    cards = "".join(f'<a class="mntl-card" href="{u}">A recipe</a>' for u in urls)
    return f"""<html><body>
      <a href="https://www.allrecipes.com/">Home</a>
      <a href="https://www.allrecipes.com/recipes/17562/dinner/">Dinner ideas</a>
      <a href="https://www.allrecipes.com/article/how-to-braise/">How to braise</a>
      {cards}
    </body></html>"""


def _title_from(url: str) -> str:
    """What a site's search reports as a hit's title. Real ones mirror the
    slug, which is what makes the slug a usable stand-in when they do not."""
    return url.rstrip("/").rsplit("/", 1)[-1].replace("-", " ").title()


class FakeNet:
    """Stands in for the whole internet: site search keyed by host, plus the
    recipe pages the results point at."""

    def __init__(self, results: dict[str, list[str]], pages: dict[str, str]):
        self.results = results
        self.pages = pages
        self.fetched: list[str] = []

    async def get(self, client, url, params=None, timeout=None):
        request = httpx.Request("GET", url)
        if "/wp-json/" in url:
            host = httpx.URL(url).host
            if host not in self.results:
                return httpx.Response(500, text="boom", request=request)
            body = [{"url": u, "title": _title_from(u)} for u in self.results[host]]
            return httpx.Response(200, json=body, request=request)
        # AllRecipes has no search API; it is scraped from its results page.
        if url == "https://www.allrecipes.com/search":
            host = httpx.URL(url).host
            if host not in self.results:
                return httpx.Response(500, text="boom", request=request)
            html = _allrecipes_search_html(self.results[host])
            return httpx.Response(200, text=html, request=request)
        self.fetched.append(url)
        if url not in self.pages:
            return httpx.Response(404, text="gone", request=request)
        return httpx.Response(200, text=self.pages[url], request=request)


@pytest.fixture
def fake_net(monkeypatch):
    def install(results, pages):
        net = FakeNet(results, pages)

        async def fake_get(self, url, params=None, timeout=None, **kwargs):
            return await net.get(self, str(url), params, timeout)

        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
        return net

    return install


async def test_search_gathers_drafts_across_sites(fake_net):
    a, b = "https://www.budgetbytes.com/x/", "https://cookieandkate.com/y/"
    fake_net(
        {"www.budgetbytes.com": [a], "cookieandkate.com": [b]},
        {a: _recipe_html("Budget Banana Bread"), b: _recipe_html("Kate Banana Bread")},
    )
    drafts = await search_recipes("banana bread")
    assert {d.title for d in drafts} == {"Budget Banana Bread", "Kate Banana Bread"}
    assert {d.source_url for d in drafts} == {a, b}
    assert all(len(d.ingredients) == 6 for d in drafts)


async def test_search_drops_failures_but_keeps_the_rest(fake_net):
    good = "https://www.budgetbytes.com/good/"
    missing = "https://cookieandkate.com/404/"
    unparseable = "https://minimalistbaker.com/blog/"
    net = fake_net(
        {
            "www.budgetbytes.com": [good],
            "cookieandkate.com": [missing],
            "minimalistbaker.com": [unparseable],
            # Every other site's search API errors out.
        },
        {
            good: _recipe_html("Surviving Banana Bread"),
            unparseable: "<html><body>a post</body></html>",
        },
    )
    drafts = await search_recipes("banana bread")
    assert [d.title for d in drafts] == ["Surviving Banana Bread"]
    assert missing in net.fetched and unparseable in net.fetched


async def test_search_deduplicates_urls(fake_net):
    shared = "https://www.budgetbytes.com/same/"
    net = fake_net(
        {"www.budgetbytes.com": [shared], "cookieandkate.com": [shared]},
        {shared: _recipe_html("Banana Bread Only Once")},
    )
    drafts = await search_recipes("banana bread")
    assert len(drafts) == 1
    assert net.fetched.count(shared) == 1


async def test_search_endpoint_returns_drafts(client, fake_net):
    url = "https://www.budgetbytes.com/x/"
    fake_net({"www.budgetbytes.com": [url]}, {url: _recipe_html("Banana Bread")})
    resp = await client.post("/api/import/search", json={"query": "banana bread"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["title"] for r in body] == ["Banana Bread"]
    assert body[0]["source_url"] == url


async def test_results_are_ordered_by_relevance(fake_net):
    """Sites nominate; we rank. Their own ordering is not evidence of much,
    so a recipe that is about the query outranks one that mentions it."""
    named = "https://www.budgetbytes.com/korean-bbq-bowls/"
    described = "https://cookieandkate.com/grilled-shrimp/"
    fake_net(
        {"www.budgetbytes.com": [named], "cookieandkate.com": [described]},
        {
            named: _recipe_html("Vegan Korean BBQ Bowls"),
            described: _recipe_html(
                "Grilled Shrimp", description="Sticky Korean BBQ glaze."
            ),
        },
    )
    drafts = await search_recipes("korean bbq")
    assert [d.title for d in drafts] == ["Vegan Korean BBQ Bowls", "Grilled Shrimp"]


async def test_results_that_only_brush_against_the_query_are_dropped(fake_net):
    """The failure this exists for: searching "korean bbq" on a site whose
    post merely mentions it should not fill a tab with cauliflower wings."""
    good = "https://www.budgetbytes.com/korean-bbq-bowls/"
    aside = "https://minimalistbaker.com/crispy-cauliflower-wings/"
    net = fake_net(
        {"www.budgetbytes.com": [good], "minimalistbaker.com": [aside]},
        {
            good: _recipe_html("Korean BBQ Bowls"),
            aside: _recipe_html(
                "Crispy Breaded Cauliflower Wings",
                description="Sweet 'n' spicy glaze, 10 ingredients.",
                mentions="Great with Korean BBQ sauce on the side.",
            ),
        },
    )
    drafts = await search_recipes("korean bbq")

    assert [d.title for d in drafts] == ["Korean BBQ Bowls"]
    # It was read before it was judged: the mention is only visible in the page.
    assert aside in net.fetched


async def test_a_search_where_nothing_is_relevant_returns_nothing(fake_net):
    url = "https://www.budgetbytes.com/sheet-pan-salmon/"
    fake_net({"www.budgetbytes.com": [url]}, {url: _recipe_html("Sheet Pan Salmon")})
    assert await search_recipes("korean bbq") == []


async def test_near_misses_fill_out_a_result_set_too_thin_to_compare(fake_net):
    """Spelling a dish a second way ("kimchi jjigae" against a page titled
    "Kimchi Jigae") reads as a half-match, and dropping it would answer a
    search that found the right recipe with nothing at all."""
    sure = "https://www.budgetbytes.com/kimchi-jjigae/"
    variant = "https://cookieandkate.com/kimchi-jigae/"
    unrelated = "https://minimalistbaker.com/banana-bread/"
    fake_net(
        {
            "www.budgetbytes.com": [sure],
            "cookieandkate.com": [variant],
            "minimalistbaker.com": [unrelated],
        },
        {
            sure: _recipe_html("Kimchi Jjigae"),
            variant: _recipe_html("Kimchi Jigae (Kimchee Soup)"),
            unrelated: _recipe_html("Banana Bread"),
        },
    )
    drafts = await search_recipes("kimchi jjigae")

    # The near miss is shown, below the sure thing. The banana bread is not:
    # padding a thin list stops at results that matched something.
    assert [d.title for d in drafts] == ["Kimchi Jjigae", "Kimchi Jigae (Kimchee Soup)"]


async def test_a_query_with_no_words_in_it_never_reaches_the_network(fake_net):
    net = fake_net({"www.budgetbytes.com": ["https://www.budgetbytes.com/x/"]}, {})
    assert await search_recipes("...") == []
    assert net.fetched == []


async def test_fetches_are_spent_on_the_most_promising_candidates(fake_net):
    """Asking every site for several results overshoots what we can afford to
    fetch, so the budget goes to the candidates whose titles look right - even
    when the site that offered one ranked it last."""
    hosts = [
        "www.budgetbytes.com",
        "cookieandkate.com",
        "minimalistbaker.com",
        "www.halfbakedharvest.com",
        "thewoksoflife.com",
    ]
    buried = "https://thewoksoflife.com/korean-bbq-short-ribs/"
    results = {
        host: [f"https://{host}/post-{host[0]}{n}/" for n in range(RESULTS_PER_SITE)]
        for host in hosts
    }
    results[hosts[-1]][-1] = buried
    net = fake_net(results, {buried: _recipe_html("Korean BBQ Short Ribs")})

    drafts = await search_recipes("korean bbq")

    assert len(results) * RESULTS_PER_SITE > MAX_FETCHES  # the budget binds
    assert len(net.fetched) == MAX_FETCHES
    # Last of the last site's results, and still inside the budget.
    assert buried in net.fetched
    assert [d.title for d in drafts] == ["Korean BBQ Short Ribs"]


async def test_search_endpoint_returns_empty_list_when_nothing_matches(client, fake_net):
    """Finding nothing is a normal result, not an error: the client shows an
    empty state rather than a failure banner."""
    fake_net({}, {})
    resp = await client.post("/api/import/search", json={"query": "zzzz nonexistent"})
    assert resp.status_code == 200
    assert resp.json() == []

    # Too-short queries never reach the network.
    assert (await client.post("/api/import/search", json={"query": "a"})).status_code == 422


def test_site_label_names_allowlisted_sites():
    assert site_label("https://www.budgetbytes.com/recipe/") == "Budget Bytes"
    assert site_label("https://cookieandkate.com/recipe/") == "Cookie and Kate"
    assert site_label("https://example.com/recipe/") == "example.com"


def test_every_allowlisted_site_has_a_distinct_label_and_https_base():
    assert len({s.label for s in ALLOWLIST}) == len(ALLOWLIST)
    assert all(s.base.startswith("https://") and not s.base.endswith("/") for s in ALLOWLIST)


def test_allrecipes_is_allowlisted_with_its_own_search_strategy():
    """AllRecipes is not WordPress, so the default strategy would find nothing
    for it - and would do so silently, since search failures are swallowed."""
    site = next(s for s in ALLOWLIST if s.label == "AllRecipes")
    assert site.base == "https://www.allrecipes.com"
    assert site.search is _search_allrecipes
    assert all(
        s.search is _search_wordpress for s in ALLOWLIST if s.label != "AllRecipes"
    )


async def test_allrecipes_search_keeps_only_recipe_links(fake_net):
    """Recipe pages live at /recipe/<id>/; category and article links on the
    same results page are not recipes and must not be offered as drafts."""
    found = [
        "https://www.allrecipes.com/recipe/223042/chicken-parmesan/",
        "https://www.allrecipes.com/recipe/62696/chicken-parmesan-casserole/",
    ]
    fake_net({"www.allrecipes.com": found}, {})

    async with httpx.AsyncClient() as client:
        site = next(s for s in ALLOWLIST if s.label == "AllRecipes")
        hits = await _search_allrecipes(client, site, "chicken parmesan")

    assert [c.url for c in hits] == found


async def test_allrecipes_search_caps_results_and_deduplicates(fake_net):
    """A results page is longer than we want from any one site, and lists the
    same recipe more than once."""
    dupe = "https://www.allrecipes.com/recipe/1/a/"
    rest = [
        f"https://www.allrecipes.com/recipe/{n}/r{n}/"
        for n in range(2, RESULTS_PER_SITE + 3)
    ]
    fake_net({"www.allrecipes.com": [dupe, dupe, *rest]}, {})

    async with httpx.AsyncClient() as client:
        site = next(s for s in ALLOWLIST if s.label == "AllRecipes")
        hits = await _search_allrecipes(client, site, "anything")

    assert [c.url for c in hits] == [dupe, *rest][:RESULTS_PER_SITE]


async def test_search_includes_allrecipes_drafts(fake_net):
    """The whole point: an AllRecipes result reaches the comparison list
    alongside the WordPress sites."""
    wp = "https://www.budgetbytes.com/x/"
    ar = "https://www.allrecipes.com/recipe/223042/chicken-parmesan/"
    fake_net(
        {"www.budgetbytes.com": [wp], "www.allrecipes.com": [ar]},
        {
            wp: _recipe_html("Budget Chicken Parmesan"),
            ar: _recipe_html("AllRecipes Chicken Parmesan"),
        },
    )
    drafts = await search_recipes("chicken parmesan")

    assert {d.title for d in drafts} == {
        "Budget Chicken Parmesan",
        "AllRecipes Chicken Parmesan",
    }
    by_url = {d.source_url: d for d in drafts}
    assert site_label(by_url[ar].source_url) == "AllRecipes"


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (["8", "8 servings"], 8),
        # The informative figure is the second entry, and the larger one.
        (["1", "1 loaf (12 slices)"], 12),
        (["1", "1 loaf"], 1),
        ("makes 24 cookies", 24),
        (4, 4),
        # A pan size is not a yield.
        (["1", "1 9x13 inch pan"], 1),
        ([], None),
        ("no numbers here", None),
        (None, None),
    ],
)
def test_parse_servings(value, expected):
    assert _parse_servings(value) == expected


def test_parse_instructions_splits_a_single_prose_blob():
    blob = (
        "Preheat the oven to 350F and grease a loaf pan thoroughly with butter. "
        "Mash the bananas in a large bowl until mostly smooth with a few lumps. "
        "Stir in the melted butter, sugar, and eggs until fully combined. "
        "Bake for 60 minutes, then cool on a wire rack before slicing it."
    )
    steps = _parse_instructions([{"@type": "HowToStep", "text": blob}]).splitlines()
    assert len(steps) == 4
    assert steps[0].startswith("Preheat the oven")
    assert steps[-1].endswith("before slicing it.")


def test_parse_instructions_leaves_real_steps_alone():
    marked_up = [
        {"@type": "HowToStep", "text": "Chop the onion. Dice the garlic."},
        {"@type": "HowToStep", "text": "Fry them together."},
    ]
    assert _parse_instructions(marked_up).splitlines() == [
        "Chop the onion. Dice the garlic.",
        "Fry them together.",
    ]
