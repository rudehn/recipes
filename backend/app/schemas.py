from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator

Meal = Literal["breakfast", "lunch", "dinner", "snack"]


class StoreOut(BaseModel):
    """A Kroger store, carried exactly as Kroger describes it."""

    model_config = ConfigDict(from_attributes=True)

    location_id: str
    name: str
    address: str
    chain: str


class StoreSelection(BaseModel):
    location_id: str = Field(min_length=1, max_length=32)


class PricingStatus(BaseModel):
    """Whether the Kroger integration is configured, and against which store.

    `enabled` being false is a normal state, not a failure: pricing is opt-in
    and the rest of the app does not depend on it. `enabled` with no `store`
    is the half-configured state - credentials present, nowhere to price
    against - and prices cannot be shown until a store is chosen.
    """

    enabled: bool
    store: StoreOut | None = None


class IngredientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: float | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=50)


class IngredientOut(IngredientIn):
    model_config = ConfigDict(from_attributes=True)

    id: int


class RecipeIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    instructions: str = ""
    prep_minutes: int | None = Field(default=None, ge=0)
    cook_minutes: int | None = Field(default=None, ge=0)
    servings: int | None = Field(default=None, ge=1)
    ingredients: list[IngredientIn] = []
    tags: list[str] = []

    def normalized_tags(self) -> list[str]:
        seen: dict[str, None] = {}
        for tag in self.tags:
            cleaned = tag.strip().lower()[:50]
            if cleaned:
                seen.setdefault(cleaned, None)
        return list(seen)


class RecipeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str
    instructions: str
    image_filename: str | None
    prep_minutes: int | None
    cook_minutes: int | None
    servings: int | None
    created_at: datetime
    updated_at: datetime
    ingredients: list[IngredientOut]
    tags: list[str]


class RecipeSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    description: str
    image_filename: str | None
    prep_minutes: int | None
    cook_minutes: int | None
    servings: int | None
    tags: list[str] = []


class RecipePage(BaseModel):
    """One page of recipes plus the numbers a pager needs.

    `total` counts everything matching the filters, not the page, so the client
    can say how much is left without asking for it.
    """

    items: list[RecipeSummary]
    total: int
    page: int
    per_page: int


class TagCount(BaseModel):
    """A tag and how many recipes carry it, for the filter bar.

    The bar can no longer be derived from the loaded recipes now that a page is
    only ever part of the collection.
    """

    name: str
    count: int


class MealPlanEntryIn(BaseModel):
    plan_date: date
    meal: Meal
    recipe_id: int
    servings: int | None = Field(default=None, ge=1)


class MealPlanEntryUpdate(BaseModel):
    # None resets to the recipe's own serving count.
    servings: int | None = Field(default=None, ge=1)


class MealPlanEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    plan_date: date
    meal: Meal
    servings: int | None
    recipe: RecipeSummary


class PantryItemIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    in_stock: bool = True


class PantryItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    in_stock: bool | None = None


class PantryItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    in_stock: bool


class GroceryRecipeUse(BaseModel):
    """One recipe's call for an ingredient a grocery line stands for.

    `ingredient_id` names the row in that recipe, not the merged line: a
    grocery item is several recipes' ingredients aggregated by canonical name,
    and only the id says which of them this use was. It is what lets the app
    open the recipe on the ingredient the shopper was reading, since the
    displayed grocery name is a pick among the variants and need not match any
    recipe's own wording.
    """

    recipe_id: int
    recipe_title: str
    ingredient_id: int
    quantity: float | None
    unit: str | None


class ItemPrice(BaseModel):
    """What one grocery line costs at the chosen store.

    The description and size are Kroger's and are shown as returned. `promo`
    is present only when the item is actually on offer - it is absent rather
    than zero the rest of the time, which is most of the time.
    """

    product_id: str
    description: str
    size: str
    regular: float
    promo: float | None = None
    aisle: str = ""
    # What covering the week's requirement costs, which is ours rather than
    # Kroger's: a weight-sold item's price is a rate, so three pounds of it is
    # three times the figure on the shelf, and a package smaller than the
    # requirement has to be bought more than once.
    estimated: float | None = None


class SaleItem(BaseModel):
    """An ingredient you cook with whose product is discounted this week."""

    key: str
    name: str
    price: ItemPrice


class MatchSelection(BaseModel):
    """A hand-picked product for one ingredient.

    A null `product_id` means "do not price this line", for the ingredients no
    product answers - "salt to taste", a garnish - so they stop counting
    against coverage instead of sitting there as a permanent near-miss.
    """

    canonical_key: str = Field(min_length=1, max_length=300)
    product_id: str | None = Field(default=None, max_length=32)


class GroceryPricing(BaseModel):
    """The trip's total, and how much of the list it actually covers.

    `priced` against `total_lines` is not decoration. A total that silently
    leaves out what could not be matched looks exactly like a complete one,
    and the gap is discovered at the till.
    """

    store: StoreOut
    total: float
    # What the same trip would have cost without this week's offers. Zero is
    # the ordinary answer, so the client shows it only when there is one.
    saved: float = 0.0
    priced: int
    total_lines: int


class GroceryItem(BaseModel):
    key: str
    name: str
    # Aggregated amounts, one entry per distinct unit (e.g. "2 cups" + "1 tbsp").
    amounts: list[str]
    uses: list[GroceryRecipeUse]
    checked: bool
    # True when this line comes from the pantry restock list, not a recipe.
    from_pantry: bool = False
    pantry_item_id: int | None = None
    # Absent when pricing is off, or when nothing confident matched.
    price: ItemPrice | None = None


class GroceryList(BaseModel):
    start: date
    end: date
    items: list[GroceryItem]
    # Planned ingredients already stocked in the pantry: nothing to buy by
    # default, but shown with their amounts so the cook can decide otherwise.
    in_pantry: list[GroceryItem]
    pantry_restock: list[GroceryItem]
    # Absent whenever prices could not be attached, for any reason.
    pricing: GroceryPricing | None = None


class GroceryToggle(BaseModel):
    key: str
    checked: bool


# How the order is to be collected. Kroger's own two values, sent per item.
Modality = Literal["PICKUP", "DELIVERY"]


class CartStatus(BaseModel):
    """Whether a grocery list can be sent to a real Kroger cart.

    Three states again, and the client needs all three. `configured` false
    means the app was not set up for it - credentials, or the redirect URI the
    sign-in needs - and there is nothing to offer. Configured but not
    `connected` means nobody has signed in yet, which is the state a button
    can fix. Both true is the working state.

    `last_sent_at` is not decoration either. The Cart API cannot be read back
    and nothing can be removed from it, so sending twice orders twice, and the
    only thing standing between the shopper and that is knowing it already
    went.
    """

    configured: bool
    connected: bool
    connected_at: datetime | None = None
    last_sent_at: datetime | None = None


class CartLine(BaseModel):
    """One line as it would be ordered.

    Carries what the shopper needs to check it before it is sent: their own
    word for the ingredient, Kroger's for the product, and how many. The
    quantity is worked out from the week's meals and is not always one.
    """

    key: str
    name: str
    upc: str
    description: str
    size: str
    quantity: int


class CartPlan(BaseModel):
    """What sending the list would order, and what it would leave behind.

    `skipped` holds names rather than a count, because a number is not
    something a shopper can do anything about and a list of names is.
    """

    lines: list[CartLine]
    skipped: list[str]


class CartRequest(BaseModel):
    """Send the list for a date range, rather than a list of products.

    The server rebuilds the list and re-picks the products, so what is ordered
    is what the app itself would have priced. Taking UPCs and quantities from
    the client would make the cart something the page could be persuaded to
    fill with anything.
    """

    start: date
    end: date
    modality: Modality = "PICKUP"

    @model_validator(mode="after")
    def _range_runs_forwards(self) -> "CartRequest":
        # Checked here rather than in the route so it cannot end up behind
        # another precondition. A malformed request is a malformed request
        # whether or not an account happens to be connected.
        if self.end < self.start:
            raise ValueError("end must be on or after start")
        return self


class CartResult(BaseModel):
    """What actually went to Kroger.

    `sent_at` is absent when nothing did. A time stamped on a send of nothing
    would make the page warn that a list is already in the cart when none is,
    and that warning is the only guard against ordering twice.
    """

    added: int
    skipped: list[str]
    sent_at: datetime | None = None


class CartSignIn(BaseModel):
    """Where to send the browser to grant cart access."""

    url: str


class ImportRequest(BaseModel):
    url: HttpUrl


class RecipeSearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=100)


class RecipeDraft(BaseModel):
    """Parsed but unsaved recipe returned by the URL importer and the recipe
    search; the client prefills the form with it so the user can review before
    saving."""

    title: str
    description: str = ""
    instructions: str = ""
    prep_minutes: int | None = None
    cook_minutes: int | None = None
    servings: int | None = None
    ingredients: list[IngredientIn] = []
    image_url: str | None = None
    source_url: str
    # Human-readable name of the site this came from ("Budget Bytes"), for the
    # comparison tabs. Falls back to the bare host for anything off the
    # allowlist. Set by the caller, which is what knows the allowlist.
    source_label: str = ""


class ImageFromUrl(BaseModel):
    url: HttpUrl


class CopyWeekRequest(BaseModel):
    from_start: date
    to_start: date
