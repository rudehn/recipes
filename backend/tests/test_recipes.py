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
