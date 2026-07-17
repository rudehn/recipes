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
        ("2 cups all-purpose flour", IngredientIn(name="all-purpose flour", quantity=2, unit="cups")),
        ("1½ tsp baking soda", IngredientIn(name="baking soda", quantity=1.5, unit="tsp")),
        ("¾ cup sugar", IngredientIn(name="sugar", quantity=0.75, unit="cup")),
        ("1 1/2 lbs chicken thighs", IngredientIn(name="chicken thighs", quantity=1.5, unit="lbs")),
        ("3 ripe bananas", IngredientIn(name="ripe bananas", quantity=3, unit=None)),
        ("Salt to taste", IngredientIn(name="Salt to taste", quantity=None, unit=None)),
        ("1-2 cloves garlic", IngredientIn(name="garlic", quantity=1, unit="cloves")),
        ("2 tbsp. of olive oil", IngredientIn(name="olive oil", quantity=2, unit="tbsp")),
        ("1 pinch", IngredientIn(name="pinch", quantity=1, unit=None)),
        ("350g self-raising flour", IngredientIn(name="self-raising flour", quantity=350, unit="g")),
        ("250ml whole milk", IngredientIn(name="whole milk", quantity=250, unit="ml")),
    ],
)
def test_parse_ingredient_line(line, expected):
    assert parse_ingredient_line(line) == expected


async def test_import_endpoint_rejects_pages_without_recipe(client, monkeypatch):
    import httpx

    async def fake_get(self, url):
        return httpx.Response(200, text="<html><body>nope</body></html>", request=httpx.Request("GET", url))

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
