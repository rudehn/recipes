"""Reading a recipe pasted in as text: a note, a text file, an AI chat answer,
or a recipe card copied out of a browser.

The four fixtures are the shapes that arrive in practice, and each test pins
the whole draft, so a change to the parser shows up as a change to what the
form would be filled with."""

from pathlib import Path

import pytest

from app.schemas import PastedRecipeDraft
from app.services.recipe_text import MAX_TEXT_CHARACTERS, UnreadableText, read_recipe_text

FIXTURES = Path(__file__).parent / "fixtures" / "recipe_text"


def _fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def _summary(draft: PastedRecipeDraft) -> dict:
    """Everything the form is filled with, ingredients as (quantity, unit,
    name) so a mismatch reads as the row that came out wrong."""
    return {
        "title": draft.title,
        "description": draft.description,
        "prep_minutes": draft.prep_minutes,
        "cook_minutes": draft.cook_minutes,
        "servings": draft.servings,
        "ingredients": [(i.quantity, i.unit, i.name) for i in draft.ingredients],
        "steps": draft.instructions.split("\n") if draft.instructions else [],
        "tags": draft.tags,
        "image_url": draft.image_url,
        "source_url": draft.source_url,
        "missing": draft.missing,
    }


def test_an_ai_chat_answer_is_read_without_its_small_talk():
    draft = read_recipe_text(_fixture("ai_chat.md"), known_tags={"italian"})

    assert _summary(draft) == {
        "title": "Creamy Tomato Basil Pasta",
        "description": (
            "Tender penne in a silky tomato cream sauce, finished with fresh basil and"
            " plenty of Parmesan. It's an easy weeknight dinner that tastes like a"
            " restaurant meal."
            "\n\nNotes: Swap the cream for half-and-half for a lighter sauce."
            " Leftovers keep for 3 days in the fridge."
            "\n\nTips: Save more pasta water than you think you need; it loosens the"
            " sauce as it sits."
        ),
        "prep_minutes": 15,
        "cook_minutes": 30,
        "servings": 4,
        "ingredients": [
            (2, "tbsp", "olive oil"),
            (1, None, "small yellow onion, finely diced"),
            (3, "cloves", "garlic, minced"),
            (1, "can", "crushed tomatoes"),
            (0.5, "cup", "heavy cream"),
            (0.25, "tsp", "red pepper flakes"),
            (1, "lb", "penne"),
            (1, "cup", "grated Parmesan"),
            (0.25, "cup", "fresh basil, torn"),
            (None, None, "Salt and pepper, to taste"),
        ],
        "steps": [
            "Boil the pasta. Bring a large pot of salted water to a boil and cook the"
            " penne until al dente. Reserve 1 cup of the pasta water, then drain.",
            "Start the sauce. Heat the olive oil in a large skillet over medium heat."
            " Add the onion and cook for 5 minutes, until soft.",
            "Stir in the garlic and red pepper flakes and cook for 1 minute, until fragrant.",
            "Add the crushed tomatoes and simmer for 15 minutes, stirring now and then.",
            "Finish. Stir in the cream, then toss in the pasta with a splash of the"
            " reserved water. Fold in the Parmesan and basil, and season with salt and"
            " pepper.",
        ],
        "tags": ["italian", "main course"],
        "image_url": None,
        "source_url": None,
        "missing": [],
    }


def test_ingredients_keep_the_line_they_were_read_from_without_its_bullet():
    """The same promise a link import makes: the line rides along, so a better
    parser can be run over it later. The bullet is the list's, not the line's."""
    draft = read_recipe_text(_fixture("ai_chat.md"))

    assert [i.source_line for i in draft.ingredients[:2]] == [
        "2 tbsp olive oil",
        "1 small yellow onion, finely diced",
    ]


def test_a_plain_note_is_read_by_its_labels_and_paragraphs():
    draft = read_recipe_text(_fixture("notes_app.txt"))

    assert _summary(draft) == {
        "title": "Black Bean Soup",
        "description": "Cheap, filling, and it freezes well.",
        "prep_minutes": None,
        "cook_minutes": None,
        "servings": 6,
        "ingredients": [
            (2, "tablespoons", "olive oil"),
            (1, None, "yellow onion, diced"),
            (4, "cloves", "garlic, minced"),
            (2, "cans", "black beans, drained and rinsed"),
            (1, "can", "diced tomatoes"),
            (4, "cups", "vegetable broth"),
            (1, "tsp", "ground cumin"),
            (0.5, "tsp", "smoked paprika"),
            (None, None, "Salt and pepper to taste"),
            (None, None, "Juice of 1 lime"),
        ],
        "steps": [
            "Heat the olive oil in a large pot over medium heat. Add the onion and cook"
            " until soft, about 5 minutes. Add the garlic and cook 1 minute more.",
            "Stir in the beans, tomatoes, broth, cumin and paprika. Bring to a boil, then"
            " lower the heat and simmer for 20 minutes.",
            "Blend about half of the soup with an immersion blender, leaving the rest"
            " chunky. Season with salt, pepper and the lime juice.",
        ],
        "tags": [],
        "image_url": None,
        # Without the campaign tag the link was shared with, as a link import keeps it.
        "source_url": "https://www.budgetbytes.com/x/",
        "missing": [],
    }


def test_a_recipe_card_copied_from_a_web_page_is_read_past_its_buttons():
    draft = read_recipe_text(_fixture("web_page.txt"), known_tags={"main courses", "fried rice"})

    assert _summary(draft) == {
        "title": "Easy Chicken Fried Rice",
        "description": (
            "This chicken fried rice is quicker than takeout and a great way to use up"
            " leftover rice."
            "\n\nNotes: Day-old rice fries best, so cook it the night before if you can."
        ),
        "prep_minutes": 10,
        "cook_minutes": 25,
        "servings": 4,
        "ingredients": [
            (1, "cup", "long grain white rice"),
            (2, "tablespoons", "vegetable oil divided"),
            (1, "lb", "boneless skinless chicken breast diced"),
            (2, None, "large eggs beaten"),
            (1, "cup", "frozen peas and carrots"),
            (3, None, "green onions sliced"),
            (3, "tablespoons", "soy sauce"),
            (1, "teaspoon", "sesame oil"),
        ],
        "steps": [
            "Cook the rice according to the package directions, then spread it on a"
            " sheet pan to cool.",
            "Heat 1 tablespoon of the oil in a large skillet over medium-high heat and"
            " cook the chicken until golden, 6 to 8 minutes. Move it to a plate.",
            "Add the rest of the oil, scramble the eggs, then add the peas and carrots"
            " and cook for 2 minutes.",
            "Add the rice and chicken and stir-fry for 5 minutes, until the rice is hot"
            " and a little crisp.",
            "Stir in the soy sauce, sesame oil and green onions and serve.",
        ],
        # The course takes the box's spelling, and of the keywords only the
        # one naming a tag already in the box is offered: as a link import does.
        "tags": ["main courses", "chinese", "fried rice"],
        "image_url": None,
        "source_url": None,
        "missing": [],
    }


def test_a_bare_list_is_split_into_ingredients_and_steps_by_its_amounts():
    draft = read_recipe_text(_fixture("bare_list.txt"))

    assert _summary(draft) == {
        "title": "Garlic Butter Green Beans",
        "description": "",
        "prep_minutes": None,
        "cook_minutes": None,
        "servings": None,
        "ingredients": [
            (1, "lb", "green beans, trimmed"),
            (3, "tbsp", "butter"),
            (4, "cloves", "garlic, minced"),
            (0.5, "tsp", "kosher salt"),
            # No amount, but among the ingredients and not a sentence.
            (None, None, "Black pepper, to taste"),
            (1, "tbsp", "lemon juice"),
        ],
        "steps": [
            "Bring a large pot of salted water to a boil and blanch the green beans for"
            " 3 minutes.",
            "Drain, plunge into ice water, then pat dry.",
            "Melt the butter in a large skillet over medium heat and cook the garlic for"
            " 1 minute.",
            "Add the green beans, salt and pepper and toss for 3 to 4 minutes.",
            "Finish with the lemon juice and serve.",
        ],
        "tags": [],
        "image_url": None,
        "source_url": None,
        "missing": [],
    }


# ------------------------------------------------------------------ details ---


@pytest.mark.parametrize(
    ("lines", "prep", "cook", "servings"),
    [
        ("Prep time: 15 minutes", 15, None, None),
        ("**Prep time:** 15 min", 15, None, None),
        ("Cook: 1 hr 20 min", None, 80, None),
        ("Cook time: 1½ hours", None, 90, None),
        ("Cook time: 1 1/2 hours", None, 90, None),
        ("Bake: 25-30 minutes", None, 30, None),
        # A total and a prep time say how long the cooking is.
        ("Prep: 15 min\nTotal time: 1 hour", 15, 45, None),
        ("Total Time: 45 mins", None, 45, None),
        ("Ready in 40 minutes", None, 40, None),
        # Cook time stated outright wins over one worked out from the total.
        ("Prep: 10 min\nCook: 20 min\nTotal: 45 min", 10, 20, None),
        ("Serves 4", None, None, 4),
        ("Servings: 4-6", None, None, 6),
        ("Yield: 12 cookies", None, None, 12),
        ("Makes 2 loaves", None, None, 2),
        ("Makes about 24", None, None, 24),
        ("Yield: 1 loaf (12 slices)", None, None, 12),
        ("Serves: 4 to 6 people", None, None, 6),
        ("Prep: 10 min | Cook: 20 min | Serves 4", 10, 20, 4),
        ("Prep Time 10 mins Cook Time 25 mins Total Time 35 mins Servings 4", 10, 25, 4),
        ("Prep Time\n10 mins\nServings\n4", 10, None, 4),
    ],
)
def test_times_and_servings_are_read_however_they_are_written(lines, prep, cook, servings):
    text = f"Pancakes\n{lines}\n\nIngredients\n1 cup flour\n\nInstructions\nMix and fry."
    draft = read_recipe_text(text)

    assert (draft.prep_minutes, draft.cook_minutes, draft.servings) == (prep, cook, servings)
    # A line read as a detail is not also left in the description.
    assert draft.description == ""


def test_a_step_that_mentions_a_time_stays_a_step():
    text = (
        "Pancakes\n\nIngredients\n1 cup flour\n\nInstructions\n"
        "Cook time will depend on your pan.\nServes well with syrup."
    )
    draft = read_recipe_text(text)

    assert draft.instructions.split("\n") == [
        "Cook time will depend on your pan.",
        "Serves well with syrup.",
    ]
    assert (draft.cook_minutes, draft.servings) == (None, None)


# -------------------------------------------------------------------- title ---


@pytest.mark.parametrize("label", ["Title", "Recipe", "**Title:**"])
def test_a_labelled_title_is_the_title(label):
    colon = "" if label.endswith(":**") else ":"
    text = f"From my grandmother's box\n{label}{colon} Lemon Bars\n\nIngredients\n1 cup flour"
    draft = read_recipe_text(text)

    assert draft.title == "Lemon Bars"
    # Nothing is taken for a chat's opening when the title was labelled.
    assert draft.description == "From my grandmother's box"


def test_a_chatty_opener_is_not_taken_for_the_title():
    text = (
        "Sure! Here's a simple recipe for banana bread:\n\n"
        "Banana Bread\n\nIngredients:\n3 ripe bananas\n\nSteps:\nMash and bake."
    )
    draft = read_recipe_text(text)

    assert draft.title == "Banana Bread"
    assert draft.description == ""


def test_a_heading_wins_over_the_sentence_before_it():
    text = (
        "This is one of my favourite weeknight dinners!\n\n"
        "**Sheet Pan Gnocchi**\n\nIngredients\n1 lb gnocchi\n\nMethod\nRoast it."
    )

    assert read_recipe_text(text).title == "Sheet Pan Gnocchi"


def test_emoji_in_headings_are_decoration():
    text = (
        "# 🍝 Weeknight Pasta\n\n## 🛒 Ingredients\n- 1 lb pasta\n\n"
        "## 👩\u200d🍳 Steps\n1. Boil it."
    )
    draft = read_recipe_text(text)

    assert draft.title == "Weeknight Pasta"
    assert [i.name for i in draft.ingredients] == ["pasta"]
    assert draft.instructions == "Boil it."


# ----------------------------------------------------------------- sections ---


def test_a_closing_line_after_the_steps_is_not_a_step():
    text = (
        "# Toast\n\n## Ingredients\n- 1 slice bread\n\n## Instructions\n"
        "1. Toast the bread.\n2. Butter it.\n\n"
        "Enjoy your toast! If you'd like, I can suggest some toppings."
    )

    assert read_recipe_text(text).instructions.split("\n") == ["Toast the bread.", "Butter it."]


def test_a_last_step_that_happens_to_say_enjoy_is_kept():
    text = "Toast\n\nIngredients:\n1 slice bread\n\nDirections:\nToast it.\n\nButter it and enjoy!"

    assert read_recipe_text(text).instructions.split("\n") == ["Toast it.", "Butter it and enjoy!"]


def test_a_heading_beside_the_sections_is_a_note_not_more_steps():
    """An AI answer often ends with a heading of its own at the same level as
    "Instructions". Read past as a sub-heading, its bullets would be taken
    for more steps."""
    text = (
        "# Chili\n\n## Ingredients\n- 1 lb ground beef\n\n## Instructions\n"
        "1. Brown the beef.\n2. Simmer.\n\n"
        "## Make it a meal\n- Top with cheddar\n- Serve with cornbread"
    )
    draft = read_recipe_text(text)

    assert draft.instructions.split("\n") == ["Brown the beef.", "Simmer."]
    assert draft.description == "Make it a meal: Top with cheddar. Serve with cornbread."


def test_storage_and_serving_ideas_are_notes():
    text = (
        "Chili\n\nIngredients:\n1 lb ground beef\n\nDirections:\nSimmer it.\n\n"
        "Serving suggestions:\nTop with cheddar.\n\nStorage:\nFreezes for 3 months."
    )
    draft = read_recipe_text(text)

    assert draft.instructions == "Simmer it."
    assert draft.description == (
        "Serving suggestions: Top with cheddar.\n\nStorage: Freezes for 3 months."
    )


def test_the_description_keeps_each_heading_and_note_as_its_own_paragraph():
    """The form's description is several lines, and the recipe page shows
    paragraphs, so what was written under its own heading stays apart."""
    text = (
        "Black Bean Soup\nA cheap soup.\nIt freezes well.\n\n## Why it works\n"
        "The beans thicken it.\n\n## Ingredients\n- 2 cans beans\n"
        "Tip: rinse them first.\n\n## Notes\n- Add lime"
    )

    assert read_recipe_text(text).description == (
        "A cheap soup. It freezes well."
        "\n\nWhy it works: The beans thicken it."
        "\n\nTip: rinse them first."
        "\n\nNotes: Add lime."
    )


def test_a_step_that_states_a_time_without_a_label_stays_a_step():
    text = "Bread\n\nIngredients\n3 cups flour\n\nInstructions\nShape the loaf.\nBake 35 minutes."
    draft = read_recipe_text(text)

    assert draft.instructions.split("\n") == ["Shape the loaf.", "Bake 35 minutes."]
    assert draft.cook_minutes is None


def test_a_plain_title_wins_over_a_heading_further_down():
    text = (
        "Black Bean Soup\n\n## Why it works\nThe beans thicken it.\n\n"
        "## Ingredients\n- 2 cans beans"
    )
    draft = read_recipe_text(text)

    assert draft.title == "Black Bean Soup"
    assert draft.description == "Why it works: The beans thicken it."


def test_sub_headings_inside_the_steps_are_read_past():
    text = (
        "Lasagna\n\nIngredients\n1 lb noodles\n\nInstructions\n"
        "**For the sauce:**\n1. Brown the meat.\n2. Add the tomatoes.\n"
        "For the assembly\n1. Layer everything.\n"
    )

    assert read_recipe_text(text).instructions.split("\n") == [
        "Brown the meat.",
        "Add the tomatoes.",
        "Layer everything.",
    ]


def test_a_note_among_the_ingredients_does_not_swallow_the_rest():
    text = (
        "Muffins\n\nIngredients:\n2 cups flour\nNote: bread flour works too.\n1 egg\n\n"
        "Directions:\nMix and bake."
    )
    draft = read_recipe_text(text)

    assert [i.name for i in draft.ingredients] == ["flour", "egg"]
    assert draft.description == "Note: bread flour works too."


def test_a_quoted_tip_is_a_note_without_its_quote_mark():
    text = (
        "Cookies\n\n#### Ingredients\n* 2 cups flour\n\n#### Instructions\n1. Bake.\n\n"
        "> **Tip:** Chill the dough for 30 minutes."
    )
    draft = read_recipe_text(text)

    assert draft.instructions == "Bake."
    assert draft.description == "Tip: Chill the dough for 30 minutes."


def test_steps_are_found_after_the_ingredients_without_a_heading_of_their_own():
    text = (
        "Pancakes\n\nIngredients:\n1 cup flour\n1 egg\n1 cup milk\n\n"
        "Whisk everything together until smooth.\nFry in a hot buttered pan."
    )
    draft = read_recipe_text(text)

    assert [i.name for i in draft.ingredients] == ["flour", "egg", "milk"]
    assert draft.instructions.split("\n") == [
        "Whisk everything together until smooth.",
        "Fry in a hot buttered pan.",
    ]


def test_ingredients_are_found_before_the_steps_without_a_heading_of_their_own():
    text = "Pancakes\n1 cup flour\n1 egg\n\nDirections:\nWhisk and fry."
    draft = read_recipe_text(text)

    assert [i.name for i in draft.ingredients] == ["flour", "egg"]
    assert draft.instructions == "Whisk and fry."
    assert draft.description == ""


def test_steps_written_one_per_line_are_one_step_each():
    text = "Rice\n\nIngredients\n1 cup rice\n\nInstructions\nRinse the rice.\nBoil 18 minutes.\n"

    assert read_recipe_text(text).instructions.split("\n") == [
        "Rinse the rice.",
        "Boil 18 minutes.",
    ]


def test_a_nutrition_section_is_left_out():
    text = (
        "Oats\n\nIngredients\n½ cup oats\n\nInstructions\nCook the oats.\n\n"
        "Nutrition Facts\nServings: 1\nCalories: 150"
    )
    draft = read_recipe_text(text)

    assert draft.instructions == "Cook the oats."
    assert draft.servings is None
    assert draft.description == ""


# ------------------------------------------------------------------- source ---


@pytest.mark.parametrize(
    "line",
    [
        "Source: https://pinchofyum.com/curry",
        "From: https://pinchofyum.com/curry",
        "Original: https://pinchofyum.com/curry.",
        "**Source:** [Pinch of Yum](https://pinchofyum.com/curry)",
        "https://pinchofyum.com/curry",
    ],
)
def test_the_link_a_recipe_came_from_is_its_source(line):
    text = f"Curry\n\nIngredients\n1 can coconut milk\n\nInstructions\nSimmer.\n\n{line}"
    draft = read_recipe_text(text)

    assert draft.source_url == "https://pinchofyum.com/curry"
    assert draft.instructions == "Simmer."


def test_a_source_without_a_link_is_left_in_the_description():
    text = "Curry\nSource: Aunt May\n\nIngredients\n1 can coconut milk"
    draft = read_recipe_text(text)

    assert draft.source_url is None
    assert draft.description == "Source: Aunt May"


# --------------------------------------------------------------------- tags ---


def test_tags_take_the_spelling_the_box_already_uses():
    text = "Slaw\nCourse: Sides\nTags: Quick, Weeknight\n\nIngredients\n1 head cabbage"
    draft = read_recipe_text(text, known_tags={"side"})

    assert draft.tags == ["side", "quick", "weeknight"]


def test_keywords_are_offered_only_when_they_name_a_tag_in_the_box():
    text = "Chili\nKeywords: best chili recipe, weeknight\n\nIngredients\n1 lb beef"

    assert read_recipe_text(text, known_tags={"weeknight"}).tags == ["weeknight"]


# ------------------------------------------------------------------ missing ---


def test_what_could_not_be_found_is_named():
    draft = read_recipe_text("Mix the flour and water, then bake it until golden.")

    assert draft.title == ""
    assert draft.ingredients == []
    assert draft.instructions == "Mix the flour and water, then bake it until golden."
    assert draft.missing == ["title", "ingredients"]


def test_a_list_of_ingredients_alone_has_no_title_or_steps():
    draft = read_recipe_text("2 cups flour\n1 egg")

    assert [i.name for i in draft.ingredients] == ["flour", "egg"]
    assert draft.missing == ["title", "instructions"]


@pytest.mark.parametrize("text", ["", "   \n\t\n "])
def test_empty_text_cannot_be_read(text):
    with pytest.raises(UnreadableText):
        read_recipe_text(text)


def test_text_longer_than_any_recipe_is_refused():
    with pytest.raises(UnreadableText):
        read_recipe_text("Soup\n" + "x" * MAX_TEXT_CHARACTERS)


# ----------------------------------------------------------------- endpoint ---


async def test_the_endpoint_reads_pasted_text_into_a_draft(client):
    resp = await client.post("/api/import/text", json={"text": _fixture("notes_app.txt")})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["title"] == "Black Bean Soup"
    assert body["source_url"] == "https://www.budgetbytes.com/x/"
    assert body["source_label"] == "Budget Bytes"
    assert body["saved_recipe_id"] is None
    assert body["missing"] == []


async def test_the_endpoint_says_what_is_missing(client):
    resp = await client.post("/api/import/text", json={"text": "Mix it all and bake."})

    assert resp.status_code == 200, resp.text
    assert resp.json()["missing"] == ["title", "ingredients"]
    assert resp.json()["source_url"] is None


async def test_pasted_text_from_a_saved_page_says_it_is_already_in_the_box(client):
    saved = (
        await client.post(
            "/api/recipes",
            json={"title": "Black bean soup", "source_url": "https://budgetbytes.com/x"},
        )
    ).json()

    resp = await client.post("/api/import/text", json={"text": _fixture("notes_app.txt")})

    assert resp.json()["saved_recipe_id"] == saved["id"]


async def test_pasted_text_without_a_link_matches_no_saved_recipe(client):
    # Saved before links were kept: a draft with no link must not match it.
    await client.post("/api/recipes", json={"title": "Toast"})

    resp = await client.post("/api/import/text", json={"text": _fixture("bare_list.txt")})

    assert resp.json()["saved_recipe_id"] is None


async def test_the_endpoint_spells_tags_the_way_the_box_spells_them(client):
    await client.post("/api/recipes", json={"title": "Slaw", "tags": ["side"]})

    resp = await client.post(
        "/api/import/text", json={"text": "Beans\nCourse: Sides\n\nIngredients\n1 lb beans"}
    )

    assert resp.json()["tags"] == ["side"]


@pytest.mark.parametrize("text", ["", "  \n "])
async def test_the_endpoint_refuses_empty_text_with_a_reason(client, text):
    resp = await client.post("/api/import/text", json={"text": text})

    assert resp.status_code == 422
    assert isinstance(resp.json()["detail"], str)


async def test_the_endpoint_refuses_text_too_long_to_be_a_recipe_with_a_reason(client):
    resp = await client.post(
        "/api/import/text", json={"text": "y" * (MAX_TEXT_CHARACTERS + 1)}
    )

    assert resp.status_code == 422
    assert "too long" in resp.json()["detail"]
