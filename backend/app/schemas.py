from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

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


# Why a line's number is what it is, when the reason is a problem. One
# vocabulary for both halves of the arithmetic: the recipe side
# (`services.lint`) and the product side (`kroger.pricing`). Ordered most
# serious first; a line shows only the first that applies.
LineIssue = Literal[
    "amount_in_name", "no_amount", "check_line", "no_match", "unsized", "out_of_stock"
]


class IngredientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    quantity: float | None = Field(default=None, ge=0)
    unit: str | None = Field(default=None, max_length=50)
    # The line as the recipe's page wrote it, kept so a better parser can be
    # run over it later without importing the recipe again. Absent for rows
    # typed by hand.
    source_line: str | None = Field(default=None, max_length=300)


class IngredientOut(IngredientIn):
    model_config = ConfigDict(from_attributes=True)

    id: int
    # The recipe-side problem with this row, if any. See services.lint.
    issue: LineIssue | None = None


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
    # False when Kroger says the shelf is empty today. The product is still
    # the right one and still priced; it just cannot be ordered until it is
    # back, and the line says so rather than quietly sending nothing.
    in_stock: bool = True
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


class RecipeOnSale(BaseModel):
    """A recipe with something discounted in it this week.

    `ingredient_count` is there so the discount can be read against the
    whole: two of three ingredients on offer is a reason to cook the thing,
    two of nineteen is a coincidence.
    """

    recipe: RecipeSummary
    on_sale: list[SaleItem]
    ingredient_count: int


class RememberedPick(BaseModel):
    """One ingredient's remembered product at the chosen store.

    `product` is absent for a line that matched nothing or was marked as not
    to be priced; `hand_picked` says which of those, and whether a present
    product was the shopper's choice or the matcher's.
    """

    key: str
    name: str
    product: ItemPrice | None = None
    hand_picked: bool
    resolved_at: datetime


class CostLine(BaseModel):
    """What one ingredient costs a recipe.

    `cost` is absent when the line could not be priced. `whole_package`
    says the figure is the price of a package rather than the share the
    recipe uses, which happens when the amount cannot be related to the
    package - "1 bunch parsley" against a bunch is right that way, "2 sprigs"
    is not, and nothing can tell them apart, so the figure is shown with
    the reason beside it rather than hidden inside the total.
    """

    ingredient_id: int
    name: str
    cost: float | None = None
    whole_package: bool = False
    product: ItemPrice | None = None


class RecipeCost(BaseModel):
    """What a recipe costs to cook, and how much of it that figure covers.

    Never a total that implies completeness. `priced` against `total_lines`
    travels with every figure, because "$8.40" for a recipe with three
    unpriced ingredients reads exactly like "$8.40" for one fully priced.
    """

    store: StoreOut
    total: float
    per_serving: float | None = None
    priced: int
    total_lines: int
    lines: list[CostLine]


class DayCost(BaseModel):
    plan_date: date
    total: float
    priced: int
    total_lines: int


class PlanCost(BaseModel):
    """What a range of planned meals costs, and what the shopping for it costs.

    The two are different numbers on purpose. `total` prices the share of a
    package each meal uses, scaled to its planned servings; `grocery_total`
    prices the whole packages the grocery list would buy for the same days.
    The gap between them is the pantry surplus the shopper is left holding,
    which is worth seeing rather than hiding.
    """

    store: StoreOut
    total: float
    priced: int
    total_lines: int
    days: list[DayCost]
    grocery_total: float | None = None


class IngredientIssue(BaseModel):
    ingredient_id: int
    name: str
    issue: LineIssue


class RecipeAttention(BaseModel):
    """A recipe with ingredient rows that will price or shop wrongly."""

    recipe: RecipeSummary
    issues: list[IngredientIssue]


class CheapRecipe(BaseModel):
    """A recipe that costs less per serving than the median across the box."""

    recipe: RecipeSummary
    per_serving: float
    priced: int
    total_lines: int


class PantryRecipe(BaseModel):
    """A recipe most of whose ingredients the pantry already has in stock."""

    recipe: RecipeSummary
    in_pantry: int
    total_lines: int


class Suggestions(BaseModel):
    """Reasons to cook something this week, each list most compelling first.

    `median_per_serving` is what `cheap` is measured against, so the page can
    say "under $2.10 a serving" rather than just "cheap". Absent when nothing
    could be costed.
    """

    on_sale: list[RecipeOnSale]
    cheap: list[CheapRecipe]
    median_per_serving: float | None = None
    pantry: list[PantryRecipe]


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


# What a shopper has said about a line this trip. "to_buy" is the default and
# is what the absence of a mark means. "bought" is the tick: in the trolley,
# still paid for. "have" is the other answer - enough at home already - and
# takes the line out of the estimate and the cart without striking it through
# as bought.
GroceryStatus = Literal["to_buy", "bought", "have"]


class GroceryItem(BaseModel):
    key: str
    name: str
    # Aggregated amounts, one entry per distinct unit (e.g. "2 cups" + "1 tbsp").
    amounts: list[str]
    uses: list[GroceryRecipeUse]
    status: GroceryStatus = "to_buy"
    # True when this line comes from the pantry restock list, not a recipe.
    from_pantry: bool = False
    pantry_item_id: int | None = None
    # Why the number is doubtful, when it is. The list endpoint fills in the
    # recipe-side reasons, which need no store; the prices endpoint adds the
    # product-side ones. The most serious one is kept.
    issue: LineIssue | None = None
    # Absent when pricing is off, or when nothing confident matched.
    price: ItemPrice | None = None
    # Whether a person chose the product for this line - or chose that it
    # should have none - rather than the matcher. A remembered choice the
    # shopper cannot see is indistinguishable from a guess, and the way back
    # to the automatic pick only makes sense for a line that has left it.
    hand_picked: bool = False


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


class LinePricing(BaseModel):
    """What the store says about one grocery line, keyed to the list."""

    key: str
    price: ItemPrice | None = None
    hand_picked: bool = False
    issue: LineIssue | None = None


class GroceryPrices(BaseModel):
    """The prices for a list, served after the list itself.

    The list is the product and is served at once, from the database alone.
    This is the garnish, fetched second, so the page never waits on Kroger
    to show what to buy. `pricing` is absent for the same reasons it is
    absent from a list - off, no store, unreachable, nothing matched.
    """

    pricing: GroceryPricing | None = None
    lines: list[LinePricing]


class GroceryMark(BaseModel):
    """Say what a line is this trip. "to_buy" takes any mark off it."""

    key: str = Field(min_length=1, max_length=300)
    status: GroceryStatus


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
    # The callback this server will hand Kroger, so the settings page can show
    # the one string that has to be registered on the Kroger app. A mismatch
    # is refused by Kroger before the browser ever comes back, so the app
    # cannot detect it and can only make it easy to check. Not a secret: it is
    # a public URL that appears in the address bar during the sign-in.
    redirect_uri: str = ""


class CartLine(BaseModel):
    """One line as it would be ordered.

    Carries what the shopper needs to check it before it is sent: their own
    word for the ingredient, Kroger's for the product, how many, and the
    amount the meals asked for that the count is meant to cover. The
    quantity is worked out from that amount and is not always one, and a
    number with the reason for it beside it - "2 × 1 lb, for 1½ lb" - can be
    checked where a bare "2" can only be trusted.
    """

    key: str
    name: str
    upc: str
    description: str
    size: str
    quantity: int
    # The week's requirement as the grocery list shows it, one entry per unit.
    amounts: list[str] = []
    # Why the count is what it is, when it could not be worked out: the
    # amount could not be related to the package, so it is one, and the
    # stepper is the shopper's to use knowingly.
    issue: LineIssue | None = None


# The most of one product a single send will order. There is no recipe that
# needs more; a number past this is a slipped finger on a stepper.
MAX_CART_QUANTITY = 99


class SentLine(BaseModel):
    """A line this app already sent to the cart this trip.

    A fact about this app's request, not about the cart, which cannot be
    read: the shopper may have taken it out again on kroger.com. So it is
    "sent" and never "in your cart".
    """

    key: str
    name: str
    description: str
    quantity: int
    sent_at: datetime


class CartPlan(BaseModel):
    """What sending the list would order, and what it would leave behind.

    `skipped` holds names rather than a count, because a number is not
    something a shopper can do anything about and a list of names is. The
    same goes for `out_of_stock`, which are lines whose product the store
    has none of today - matched, priced, and still not orderable - and for
    `sent`, the lines a previous send this trip already put in the cart and
    this one therefore leaves out unless asked.
    """

    lines: list[CartLine]
    skipped: list[str]
    out_of_stock: list[str] = []
    sent: list[SentLine] = []


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
    # Counts the shopper set by hand in the review, by line key. Only the
    # count: the product still comes from the server's own plan, and a key
    # the plan does not carry is ignored rather than ordered. The arithmetic
    # behind the automatic count is bounded by the density table, and a
    # person reading "1 × 12 ct, for 24 eggs" can do the sum it could not.
    quantities: dict[str, int] = {}
    # Lines already sent this trip that the shopper wants sent again anyway,
    # by key. Without this a second send leaves them out, which is the only
    # guard there is against ordering the first send twice.
    resend: list[str] = []

    @field_validator("quantities")
    @classmethod
    def _counts_are_orderable(cls, quantities: dict[str, int]) -> dict[str, int]:
        for key, count in quantities.items():
            if not 1 <= count <= MAX_CART_QUANTITY:
                raise ValueError(f"quantity for {key!r} must be between 1 and {MAX_CART_QUANTITY}")
        return quantities

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
