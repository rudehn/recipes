import pytest

PANCAKES = {
    "title": "Pancakes",
    "description": "Fluffy weekend pancakes",
    "instructions": "Mix dry ingredients\nAdd wet ingredients\nCook on griddle",
    "prep_minutes": 10,
    "cook_minutes": 15,
    "servings": 4,
    "ingredients": [
        {"name": "Flour", "quantity": 2, "unit": "cups"},
        {"name": "Milk", "quantity": 1.5, "unit": "cups"},
        {"name": "Eggs", "quantity": 2, "unit": None},
        {"name": "Salt", "quantity": None, "unit": None},
    ],
}

# Minimal valid 1x1 PNG.
PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082"
)


async def test_create_and_get_recipe(client):
    resp = await client.post("/api/recipes", json=PANCAKES)
    assert resp.status_code == 201, resp.text
    recipe = resp.json()
    assert recipe["title"] == "Pancakes"
    assert [i["name"] for i in recipe["ingredients"]] == [
        "Flour", "Milk", "Eggs", "Salt",
    ]

    resp = await client.get(f"/api/recipes/{recipe['id']}")
    assert resp.status_code == 200
    assert resp.json()["instructions"].splitlines()[0] == "Mix dry ingredients"


async def test_list_recipes(client):
    await client.post("/api/recipes", json=PANCAKES)
    await client.post("/api/recipes", json={**PANCAKES, "title": "Crepes"})
    resp = await client.get("/api/recipes")
    assert resp.status_code == 200
    body = resp.json()
    assert [r["title"] for r in body["items"]] == ["Crepes", "Pancakes"]
    assert body["total"] == 2
    assert body["page"] == 1


async def test_update_recipe_replaces_ingredients(client):
    recipe = (await client.post("/api/recipes", json=PANCAKES)).json()
    updated = {
        **PANCAKES,
        "title": "Vegan Pancakes",
        "ingredients": [{"name": "Oat milk", "quantity": 2, "unit": "cups"}],
    }
    resp = await client.put(f"/api/recipes/{recipe['id']}", json=updated)
    assert resp.status_code == 200
    body = resp.json()
    assert body["title"] == "Vegan Pancakes"
    assert [i["name"] for i in body["ingredients"]] == ["Oat milk"]


async def test_delete_recipe(client):
    recipe = (await client.post("/api/recipes", json=PANCAKES)).json()
    resp = await client.delete(f"/api/recipes/{recipe['id']}")
    assert resp.status_code == 204
    assert (await client.get(f"/api/recipes/{recipe['id']}")).status_code == 404


async def test_validation_rejects_empty_title(client):
    resp = await client.post("/api/recipes", json={**PANCAKES, "title": ""})
    assert resp.status_code == 422


async def test_image_upload_and_serving(client, images_dir):
    recipe = (await client.post("/api/recipes", json=PANCAKES)).json()
    resp = await client.post(
        f"/api/recipes/{recipe['id']}/image",
        files={"file": ("pancakes.png", PNG_BYTES, "image/png")},
    )
    assert resp.status_code == 200, resp.text
    filename = resp.json()["image_filename"]
    assert filename and (images_dir / filename).is_file()

    resp = await client.get(f"/api/images/{filename}")
    assert resp.status_code == 200
    assert resp.content == PNG_BYTES


async def test_image_upload_replaces_old_file(client, images_dir):
    recipe = (await client.post("/api/recipes", json=PANCAKES)).json()
    first = (
        await client.post(
            f"/api/recipes/{recipe['id']}/image",
            files={"file": ("a.png", PNG_BYTES, "image/png")},
        )
    ).json()["image_filename"]
    second = (
        await client.post(
            f"/api/recipes/{recipe['id']}/image",
            files={"file": ("b.png", PNG_BYTES, "image/png")},
        )
    ).json()["image_filename"]
    assert first != second
    assert not (images_dir / first).exists()
    assert (images_dir / second).is_file()


async def test_image_upload_rejects_bad_type(client):
    recipe = (await client.post("/api/recipes", json=PANCAKES)).json()
    resp = await client.post(
        f"/api/recipes/{recipe['id']}/image",
        files={"file": ("evil.svg", b"<svg/>", "image/svg+xml")},
    )
    assert resp.status_code == 415


async def test_a_recipe_says_which_rows_need_a_look(client):
    """The recipe page is where the fix is, so the reason rides on the row."""
    resp = await client.post(
        "/api/recipes",
        json={
            "title": "Salsa",
            "ingredients": [
                {"name": "Optional: 1 diced ripe avocado", "quantity": None, "unit": None},
                {"name": "salt", "quantity": None, "unit": None},
                {"name": "corn", "quantity": 3, "unit": "cup", "source_line": "3 cups corn"},
            ],
        },
    )

    assert resp.status_code == 201, resp.text
    rows = {i["name"]: i for i in resp.json()["ingredients"]}
    assert rows["Optional: 1 diced ripe avocado"]["issue"] == "amount_in_name"
    assert rows["salt"]["issue"] is None
    assert rows["corn"]["issue"] is None
    # The line as imported is kept for a later re-parse.
    assert rows["corn"]["source_line"] == "3 cups corn"


async def test_a_recipe_remembers_where_it_came_from(client):
    url = "https://www.budgetbytes.com/one-pot-chili/"
    resp = await client.post("/api/recipes", json={**PANCAKES, "source_url": url})
    assert resp.status_code == 201, resp.text
    assert resp.json()["source_url"] == url
    # Named the way the search tabs name it, for "View original on ...".
    assert resp.json()["source_label"] == "Budget Bytes"

    stored = (await client.get(f"/api/recipes/{resp.json()['id']}")).json()
    assert stored["source_url"] == url
    assert stored["source_label"] == "Budget Bytes"


async def test_a_source_off_the_allowlist_is_named_by_its_host(client):
    resp = await client.post(
        "/api/recipes",
        json={**PANCAKES, "source_url": "https://www.seriouseats.com/pancakes"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["source_label"] == "seriouseats.com"


async def test_a_typed_source_is_named_whatever_case_its_host_is_in(client):
    """Links the importer hands over arrive with the host lowercased; one
    pasted into the form arrives however it was typed."""
    resp = await client.post(
        "/api/recipes",
        json={**PANCAKES, "source_url": "https://WWW.BudgetBytes.com/one-pot-chili/"},
    )
    assert resp.json()["source_label"] == "Budget Bytes"


@pytest.mark.parametrize("blank", [None, "", "   "])
async def test_a_recipe_without_a_source_has_none(client, blank):
    """Typed in by hand, or saved before sources were kept. A blank field on
    the form is no link, not a link to nowhere."""
    resp = await client.post("/api/recipes", json={**PANCAKES, "source_url": blank})
    assert resp.status_code == 201, resp.text
    assert resp.json()["source_url"] is None
    assert resp.json()["source_label"] is None


async def test_a_source_is_kept_without_the_space_around_it(client):
    resp = await client.post(
        "/api/recipes",
        json={**PANCAKES, "source_url": "  https://cookieandkate.com/pancakes/\n"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["source_url"] == "https://cookieandkate.com/pancakes/"


@pytest.mark.parametrize(
    "bad",
    [
        # Rendered as a link on the recipe page, so a script must never get in.
        "javascript:alert(1)",
        "ftp://example.com/pancakes",
        # Without a scheme the browser would read it as a path on this app.
        "www.budgetbytes.com/one-pot-chili/",
        "https://exa mple.com/pancakes",
        "https://example.com/" + "a" * 2048,
    ],
)
async def test_a_source_must_be_a_web_link(client, bad):
    resp = await client.post("/api/recipes", json={**PANCAKES, "source_url": bad})
    assert resp.status_code == 422


async def test_editing_adds_changes_and_clears_the_source(client):
    """The edit form is how links are added to recipes saved before sources
    were kept, and how a wrong one is fixed or taken off."""
    recipe = (await client.post("/api/recipes", json=PANCAKES)).json()
    assert recipe["source_url"] is None

    first = "https://pinchofyum.com/pancakes"
    resp = await client.put(f"/api/recipes/{recipe['id']}", json={**PANCAKES, "source_url": first})
    assert resp.status_code == 200, resp.text
    assert resp.json()["source_url"] == first
    assert resp.json()["source_label"] == "Pinch of Yum"

    fixed = "https://cookieandkate.com/pancakes/"
    resp = await client.put(f"/api/recipes/{recipe['id']}", json={**PANCAKES, "source_url": fixed})
    assert resp.json()["source_url"] == fixed

    # A PUT replaces the recipe, so a form that sends no link clears it.
    resp = await client.put(f"/api/recipes/{recipe['id']}", json=PANCAKES)
    assert resp.json()["source_url"] is None
    stored = (await client.get(f"/api/recipes/{recipe['id']}")).json()
    assert stored["source_url"] is None
