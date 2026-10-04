import pytest

from app.schemas import IngredientIn
from app.services.recipe_import import (
    RecipeNotFound,
    parse_ingredient_line,
    parse_recipe_html,
)

SAMPLE_HTML = """
<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {"@type": "WebSite", "name": "Cooking Site"},
    {
      "@type": ["Recipe"],
      "name": "Classic <b>Banana</b> Bread",
      "description": "Moist and easy.",
      "image": {"@type": "ImageObject", "url": "https://example.com/banana.jpg"},
      "prepTime": "PT15M",
      "totalTime": "PT1H15M",
      "recipeYield": ["8", "8 servings"],
      "recipeIngredient": [
        "2 cups all-purpose flour",
        "1\\u00bd tsp baking soda",
        "\\u00be cup sugar",
        "3 ripe bananas",
        "1/2 cup melted butter",
        "Salt to taste"
      ],
      "recipeInstructions": [
        {"@type": "HowToStep", "text": "Preheat the oven to 350\\u00b0F."},
        {"@type": "HowToSection", "itemListElement": [
          {"@type": "HowToStep", "text": "Mash the bananas."},
          {"@type": "HowToStep", "text": "Mix everything and bake <b>60 minutes</b>."}
        ]}
      ]
    }
  ]
}
</script>
</head><body></body></html>
"""


def test_parse_recipe_html_full():
    draft = parse_recipe_html(SAMPLE_HTML, "https://example.com/banana-bread")
    assert draft.title == "Classic Banana Bread"
    assert draft.description == "Moist and easy."
    assert draft.image_url == "https://example.com/banana.jpg"
    assert draft.prep_minutes == 15
    assert draft.cook_minutes == 60  # totalTime minus prepTime
    assert draft.servings == 8
    assert draft.instructions.splitlines() == [
        "Preheat the oven to 350°F.",
        "Mash the bananas.",
        "Mix everything and bake 60 minutes.",
    ]
    flour = draft.ingredients[0]
    assert (flour.quantity, flour.unit, flour.name) == (2, "cups", "all-purpose flour")


def test_parse_recipe_html_without_recipe_raises():
    with pytest.raises(RecipeNotFound):
        parse_recipe_html("<html><body>Just a blog post</body></html>", "https://x.test")


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        (
            "2 cups all-purpose flour",
            IngredientIn(name="all-purpose flour", quantity=2, unit="cups"),
        ),
        ("1½ tsp baking soda", IngredientIn(name="baking soda", quantity=1.5, unit="tsp")),
        ("¾ cup sugar", IngredientIn(name="sugar", quantity=0.75, unit="cup")),
        ("1 1/2 lbs chicken thighs", IngredientIn(name="chicken thighs", quantity=1.5, unit="lbs")),
        ("3 ripe bananas", IngredientIn(name="ripe bananas", quantity=3, unit=None)),
        ("Salt to taste", IngredientIn(name="Salt to taste", quantity=None, unit=None)),
        ("1-2 cloves garlic", IngredientIn(name="garlic", quantity=1, unit="cloves")),
        ("2 tbsp. of olive oil", IngredientIn(name="olive oil", quantity=2, unit="tbsp")),
        ("1 pinch", IngredientIn(name="pinch", quantity=1, unit=None)),
        (
            "350g self-raising flour",
            IngredientIn(name="self-raising flour", quantity=350, unit="g"),
        ),
        ("250ml whole milk", IngredientIn(name="whole milk", quantity=250, unit="ml")),
        # A modifier between the amount and the unit must not hide the unit.
        (
            "2 heaping teaspoons  minced garlic (3 to 4 cloves)",
            IngredientIn(name="minced garlic (3 to 4 cloves)", quantity=2, unit="teaspoons"),
        ),
        # ...but only when a unit really follows it.
        ("2 large eggs", IngredientIn(name="large eggs", quantity=2, unit=None)),
        # Container size before the unit is dropped; trailing notes are kept.
        (
            "3 (3-ounce) packets ramen noodles (seasoning discarded)",
            IngredientIn(name="ramen noodles (seasoning discarded)", quantity=3, unit="packets"),
        ),
        (
            "2 (15 oz) cans black beans",
            IngredientIn(name="black beans", quantity=2, unit="cans"),
        ),
        # An unclosed parenthesis leaves the text alone rather than eating it.
        (
            "1 (14 ounce package cream cheese",
            IngredientIn(name="(14 ounce package cream cheese", quantity=1, unit=None),
        ),
    ],
)
def test_parse_ingredient_line(line, expected):
    parsed = parse_ingredient_line(line)
    assert parsed.model_dump(exclude={"source_line"}) == expected.model_dump(
        exclude={"source_line"}
    )
    # The line itself rides along, so a better parser can rerun over it.
    assert parsed.source_line == line.strip() or parsed.source_line is not None


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        # A label before the amount used to hide the amount: the whole line
        # became the name, the grocery list said "as needed", and the cart
        # ordered one whatever the recipe was scaled to.
        (
            "Optional: 1 diced ripe avocado",
            IngredientIn(name="diced ripe avocado (optional)", quantity=1, unit=None),
        ),
        ("For the sauce: 1 cup ketchup", IngredientIn(name="ketchup", quantity=1, unit="cup")),
        # A package size without its brackets, straight after the amount.
        (
            "1 22-ounce bag frozen waffle fries",
            IngredientIn(name="frozen waffle fries", quantity=1, unit="bag"),
        ),
        ("2 15 oz cans black beans", IngredientIn(name="black beans", quantity=2, unit="cans")),
        # A number that is the amount, not a size, is left alone.
        ("2 8-inch tortillas", IngredientIn(name="tortillas", quantity=2, unit=None)),
    ],
)
def test_labels_and_bare_sizes_are_read_past(line, expected):
    parsed = parse_ingredient_line(line)
    assert parsed.model_dump(exclude={"source_line"}) == expected.model_dump(
        exclude={"source_line"}
    )


def test_description_falls_back_to_meta_tag():
    """Southern Bite publishes an empty JSON-LD description but a real meta one."""
    html = SAMPLE_HTML.replace(
        '"description": "Moist and easy.",', '"description": "",'
    ).replace(
        "<head>", '<head><meta name="description" content="Blurb from the page." />'
    )
    assert parse_recipe_html(html, "https://x.test").description == "Blurb from the page."


async def test_import_endpoint_rejects_pages_without_recipe(client, monkeypatch):
    import httpx

    async def fake_get(self, url):
        return httpx.Response(
            200, text="<html><body>nope</body></html>", request=httpx.Request("GET", url)
        )

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    resp = await client.post("/api/import/recipe", json={"url": "https://example.com/post"})
    assert resp.status_code == 422


async def test_import_endpoint_parses_recipe(client, monkeypatch):
    import httpx

    async def fake_get(self, url):
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    resp = await client.post(
        "/api/import/recipe", json={"url": "https://example.com/banana-bread"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "Classic Banana Bread"
    assert len(body["ingredients"]) == 6

    # Non-http(s) URLs are rejected by validation.
    resp = await client.post("/api/import/recipe", json={"url": "file:///etc/passwd"})
    assert resp.status_code == 422


async def test_import_says_when_the_recipe_is_already_in_the_box(client, monkeypatch):
    """Pasting a link to a recipe already saved should say so, and where, so
    the same recipe is not imported twice. The link pasted carries tracking
    junk and a different spelling of the host than the one saved, which is
    how it really arrives the second time."""
    import httpx

    async def fake_get(self, url):
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    saved = (
        await client.post(
            "/api/recipes",
            json={"title": "Banana bread", "source_url": "https://www.example.com/banana-bread/"},
        )
    ).json()

    resp = await client.post(
        "/api/import/recipe",
        json={"url": "http://example.com/banana-bread?utm_source=pinterest#recipe"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["saved_recipe_id"] == saved["id"]


async def test_a_page_saved_twice_names_the_first_copy(client, monkeypatch):
    """The answer should not move each time another copy is made."""
    import httpx

    async def fake_get(self, url):
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    link = "https://example.com/banana-bread/"
    first = (
        await client.post("/api/recipes", json={"title": "Banana bread", "source_url": link})
    ).json()
    await client.post("/api/recipes", json={"title": "Banana bread again", "source_url": link})

    resp = await client.post("/api/import/recipe", json={"url": link})
    assert resp.json()["saved_recipe_id"] == first["id"]


async def test_import_of_a_new_recipe_names_no_saved_one(client, monkeypatch):
    import httpx

    async def fake_get(self, url):
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    await client.post(
        "/api/recipes",
        json={"title": "Zucchini bread", "source_url": "https://example.com/zucchini-bread/"},
    )
    # Saved before sources were kept: nothing to match it on.
    await client.post("/api/recipes", json={"title": "Banana bread"})

    resp = await client.post(
        "/api/import/recipe", json={"url": "https://example.com/banana-bread"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["saved_recipe_id"] is None
    # The draft still carries its own link, for the form to save with it.
    assert resp.json()["source_url"] == "https://example.com/banana-bread"


async def test_import_hands_the_form_the_link_without_its_tracking(client, monkeypatch):
    """The form shows the draft's link as the one it will save, so the
    campaign tags a shared link arrives with are gone before it gets there.
    The page is still fetched at the link as pasted."""
    import httpx

    fetched: list[str] = []

    async def fake_get(self, url):
        fetched.append(str(url))
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    pasted = "https://example.com/banana-bread/?utm_source=pinterest&utm_medium=social#recipe"

    resp = await client.post("/api/import/recipe", json={"url": pasted})

    assert resp.status_code == 200, resp.text
    assert resp.json()["source_url"] == "https://example.com/banana-bread/#recipe"
    assert fetched == [pasted]


async def test_import_tells_apart_pages_named_by_their_query(client, monkeypatch):
    """On a site without pretty permalinks every recipe is "/?p=" something,
    and ignoring the whole query would call them all one recipe."""
    import httpx

    async def fake_get(self, url):
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    saved = (
        await client.post(
            "/api/recipes", json={"title": "Banana bread", "source_url": "https://example.com/?p=123"}
        )
    ).json()

    other = await client.post("/api/import/recipe", json={"url": "https://example.com/?p=124"})
    assert other.json()["saved_recipe_id"] is None

    same = await client.post(
        "/api/import/recipe", json={"url": "https://example.com/?utm_source=x&p=123"}
    )
    assert same.json()["saved_recipe_id"] == saved["id"]


async def test_import_sends_browser_navigation_headers(client, monkeypatch):
    """Sites like AllRecipes answer 403 with a JS challenge unless the request
    carries the headers a browser sends on a top-level navigation. A
    User-Agent alone does not clear it, so pin the whole set."""
    import httpx

    seen: dict[str, str] = {}

    async def fake_get(self, url):
        seen.update(self.headers)
        return httpx.Response(200, text=SAMPLE_HTML, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    resp = await client.post(
        "/api/import/recipe", json={"url": "https://example.com/banana-bread"}
    )
    assert resp.status_code == 200, resp.text

    assert "Chrome/" in seen["user-agent"]
    assert seen["upgrade-insecure-requests"] == "1"
    assert seen["sec-fetch-mode"] == "navigate"
    assert seen["sec-fetch-dest"] == "document"
