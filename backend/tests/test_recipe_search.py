import httpx
import pytest

from app.services.recipe_import import _parse_instructions, _parse_servings
from app.services.recipe_search import ALLOWLIST, search_recipes, site_label
from tests.test_import import SAMPLE_HTML


def _recipe_html(title: str) -> str:
    return SAMPLE_HTML.replace("Classic <b>Banana</b> Bread", title)


class FakeNet:
    """Stands in for the whole internet: search APIs keyed by host, plus the
    recipe pages they point at."""

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
            body = [{"url": u, "title": u} for u in self.results[host]]
            return httpx.Response(200, json=body, request=request)
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
        {a: _recipe_html("Budget Bread"), b: _recipe_html("Kate Bread")},
    )
    drafts = await search_recipes("banana bread")
    assert {d.title for d in drafts} == {"Budget Bread", "Kate Bread"}
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
        {good: _recipe_html("Survivor"), unparseable: "<html><body>a post</body></html>"},
    )
    drafts = await search_recipes("banana bread")
    assert [d.title for d in drafts] == ["Survivor"]
    assert missing in net.fetched and unparseable in net.fetched


async def test_search_deduplicates_urls(fake_net):
    shared = "https://www.budgetbytes.com/same/"
    net = fake_net(
        {"www.budgetbytes.com": [shared], "cookieandkate.com": [shared]},
        {shared: _recipe_html("Only Once")},
    )
    drafts = await search_recipes("banana bread")
    assert len(drafts) == 1
    assert net.fetched.count(shared) == 1


async def test_search_endpoint_returns_drafts(client, fake_net):
    url = "https://www.budgetbytes.com/x/"
    fake_net({"www.budgetbytes.com": [url]}, {url: _recipe_html("Found It")})
    resp = await client.post("/api/import/search", json={"query": "banana bread"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [r["title"] for r in body] == ["Found It"]
    assert body[0]["source_url"] == url


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
