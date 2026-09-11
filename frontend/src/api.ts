export type Meal = "breakfast" | "lunch" | "dinner" | "snack";

/** A Kroger store, exactly as Kroger describes it. Never reworded for display. */
export interface Store {
  location_id: string;
  name: string;
  address: string;
  chain: string;
}

/**
 * Whether pricing is available, and against which store.
 *
 * Three states, and they need telling apart: `enabled` false means no
 * credentials and the feature does not exist; `enabled` true with a null
 * `store` means credentials but nowhere to price against, since Kroger
 * returns no price without a store; both set means prices can be shown.
 */
export interface PricingStatus {
  enabled: boolean;
  store: Store | null;
}

/**
 * Why a line's number is doubtful, when it is. One vocabulary for both halves
 * of the arithmetic: the recipe side (amount in the name, no amount, a row
 * that is not an ingredient) and the product side (nothing matched, the
 * amount cannot be sized against the package, the shelf is empty today).
 * Ordered most serious first; a line shows only the first that applies.
 */
export type LineIssue =
  | "amount_in_name"
  | "no_amount"
  | "check_line"
  | "no_match"
  | "unsized"
  | "out_of_stock";

/** The recipe-side issues: the fix is on the recipe page, not the shop. */
export const RECIPE_ISSUES: ReadonlySet<LineIssue> = new Set<LineIssue>([
  "amount_in_name",
  "no_amount",
  "check_line",
]);

export interface Ingredient {
  id?: number;
  name: string;
  quantity: number | null;
  unit: string | null;
  /** The line as imported, kept so a better parser can rerun over it. */
  source_line?: string | null;
  /** Set by the server on rows it reads back. */
  issue?: LineIssue | null;
}

export interface RecipeSummary {
  id: number;
  title: string;
  description: string;
  image_filename: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  servings: number | null;
  tags: string[];
}

export interface Recipe extends RecipeSummary {
  instructions: string;
  ingredients: Ingredient[];
}

/** One page of a collection. `total` counts every match, not the page. */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  per_page: number;
}

/** A tag and how many recipes carry it, for the filter bar. */
export interface TagCount {
  name: string;
  count: number;
}

export interface RecipeQuery {
  /** Matches title, description, tags, and ingredient names. */
  q?: string;
  tag?: string | null;
  sort?: "title" | "newest";
  page?: number;
  per_page?: number;
}

export interface RecipeInput {
  title: string;
  description: string;
  instructions: string;
  prep_minutes: number | null;
  cook_minutes: number | null;
  servings: number | null;
  ingredients: Omit<Ingredient, "id">[];
  tags: string[];
}

export interface RecipeDraft {
  title: string;
  description: string;
  instructions: string;
  prep_minutes: number | null;
  cook_minutes: number | null;
  servings: number | null;
  ingredients: Omit<Ingredient, "id">[];
  image_url: string | null;
  source_url: string;
  /** Display name of the source site, e.g. "Budget Bytes". */
  source_label: string;
}

export interface MealPlanEntry {
  id: number;
  plan_date: string;
  meal: Meal;
  // Planned servings; null means the recipe's own serving count.
  servings: number | null;
  recipe: RecipeSummary;
}

export interface PantryItem {
  id: number;
  name: string;
  in_stock: boolean;
}

/**
 * One recipe's call for an ingredient a grocery line stands for.
 *
 * `ingredient_id` is the row in that recipe rather than the merged line, so a
 * grocery row can open the recipe on the ingredient it came from. Matching by
 * name could not: the line's name is a pick among the variants the recipes
 * used, and the merge is by canonical name, which is the server's rule.
 */
export interface GroceryRecipeUse {
  recipe_id: number;
  recipe_title: string;
  ingredient_id: number;
  quantity: number | null;
  unit: string | null;
}

/** What one line costs at the chosen store. Kroger's wording, shown as returned. */
export interface ItemPrice {
  product_id: string;
  description: string;
  size: string;
  regular: number;
  /** Present only when the item is actually on offer. */
  promo: number | null;
  aisle: string;
  /** False when Kroger says the shelf is empty today. Still the right product, still priced. */
  in_stock: boolean;
  /**
   * What covering the week's requirement costs - ours, not Kroger's.
   *
   * A weight-sold item's price is a rate, so three pounds of chicken is three
   * times the shelf figure, and a package smaller than the requirement has to
   * be bought more than once. `regular` stays Kroger's untouched.
   */
  estimated: number | null;
}

/**
 * The trip's total, and how much of the list it covers.
 *
 * Absent whenever nothing could be priced, which covers pricing being off, no
 * store chosen, Kroger being unreachable, and nothing matching. Present only
 * when at least one line has a price, so a total is never a claim that the
 * shopping is free.
 */
export interface GroceryPricing {
  store: Store;
  total: number;
  /** What this week's offers took off the total. Usually zero. */
  saved: number;
  priced: number;
  total_lines: number;
}

/** An ingredient you cook with whose product is discounted this week. */
export interface SaleItem {
  key: string;
  name: string;
  price: ItemPrice;
}

/**
 * A recipe with something discounted in it this week.
 *
 * `ingredient_count` is what the discount is read against: two of three
 * ingredients on offer is a reason to cook the thing, two of nineteen is a
 * coincidence.
 */
export interface RecipeOnSale {
  recipe: RecipeSummary;
  on_sale: SaleItem[];
  ingredient_count: number;
}

/** A recipe costing less per serving than the median across the recipe box. */
export interface CheapRecipe {
  recipe: RecipeSummary;
  per_serving: number;
  priced: number;
  total_lines: number;
}

/** A recipe most of whose ingredients the pantry has in stock. */
export interface PantryRecipe {
  recipe: RecipeSummary;
  in_pantry: number;
  total_lines: number;
}

/**
 * Reasons to cook something this week. `median_per_serving` is what `cheap`
 * is measured against, so the page can say "under $2.10 a serving"; null when
 * too little of the box has been costed to have one.
 */
export interface Suggestions {
  on_sale: RecipeOnSale[];
  cheap: CheapRecipe[];
  median_per_serving: number | null;
  pantry: PantryRecipe[];
}

/**
 * What one ingredient costs a recipe. `cost` is null when it could not be
 * priced. `whole_package` says the figure is a whole package rather than the
 * share used, because the amount could not be related to the package.
 */
export interface CostLine {
  ingredient_id: number;
  name: string;
  cost: number | null;
  whole_package: boolean;
  product: ItemPrice | null;
}

/**
 * What a recipe costs to cook. `priced` against `total_lines` is part of the
 * number: "$8.40" with three ingredients unpriced reads exactly like "$8.40"
 * fully priced.
 */
export interface RecipeCost {
  store: Store;
  total: number;
  per_serving: number | null;
  priced: number;
  total_lines: number;
  lines: CostLine[];
}

export interface DayCost {
  plan_date: string;
  total: number;
  priced: number;
  total_lines: number;
}

/**
 * What a range of planned meals costs to cook, and what shopping for it
 * costs. `total` prices the share of each package the meals use;
 * `grocery_total` prices the whole packages the list would buy. The gap is
 * the pantry surplus.
 */
export interface PlanCost {
  store: Store;
  total: number;
  priced: number;
  total_lines: number;
  days: DayCost[];
  grocery_total: number | null;
}

export interface IngredientIssue {
  ingredient_id: number;
  name: string;
  issue: LineIssue;
}

/** A recipe with ingredient rows that will price or shop wrongly. */
export interface RecipeAttention {
  recipe: RecipeSummary;
  issues: IngredientIssue[];
}

/** One ingredient's remembered product at the chosen store. */
export interface RememberedPick {
  key: string;
  name: string;
  product: ItemPrice | null;
  hand_picked: boolean;
  resolved_at: string;
}

/**
 * What the shopper has said about a line this trip.
 *
 * "to_buy" is the default. "bought" is the tick: in the trolley, still paid
 * for. "have" is the other answer a shopper gives a list - there is already
 * enough at home - and takes the line out of the estimate and the cart
 * without striking it through as bought.
 */
export type GroceryStatus = "to_buy" | "bought" | "have";

export interface GroceryItem {
  key: string;
  name: string;
  amounts: string[];
  uses: GroceryRecipeUse[];
  status: GroceryStatus;
  from_pantry: boolean;
  pantry_item_id: number | null;
  /**
   * Why the number is doubtful. The list carries the recipe-side reasons,
   * which need no store; the prices response adds the product-side ones.
   */
  issue: LineIssue | null;
  /** Absent when pricing is off, or when nothing confident matched this line. */
  price: ItemPrice | null;
  /**
   * Whether a person chose this line's product, or chose that it should have
   * none, rather than the matcher. The choice is remembered either way; this
   * is what lets the page say so.
   */
  hand_picked: boolean;
}

/** What the store says about one grocery line, keyed to the list. */
export interface LinePricing {
  key: string;
  price: ItemPrice | null;
  hand_picked: boolean;
  issue: LineIssue | null;
}

/**
 * The prices for a list, fetched after the list itself.
 *
 * The list is served from the database alone and shown at once; this is the
 * garnish, and the page never waits on Kroger to show what to buy.
 */
export interface GroceryPrices {
  pricing: GroceryPricing | null;
  lines: LinePricing[];
}

export interface GroceryList {
  start: string;
  end: string;
  items: GroceryItem[];
  /** Planned ingredients the pantry already has. Not bought unless asked for. */
  in_pantry: GroceryItem[];
  pantry_restock: GroceryItem[];
  pricing: GroceryPricing | null;
}

/** How a Kroger order is to be collected. */
export type Modality = "PICKUP" | "DELIVERY";

/**
 * Whether the grocery list can be sent to a real Kroger cart.
 *
 * Three states, as with pricing, and again they need telling apart.
 * `configured` false means the app was never set up for it - that needs a
 * redirect URI as well as credentials, because the sign-in is a browser round
 * trip. Configured but not `connected` is the state a button fixes.
 *
 * `last_sent_at` is load bearing rather than informational. Kroger's cart
 * cannot be read back and nothing can be removed from it, so sending twice
 * orders twice, and knowing the first one went is the only thing that
 * prevents it.
 */
export interface CartStatus {
  configured: boolean;
  connected: boolean;
  connected_at: string | null;
  last_sent_at: string | null;
  /**
   * The callback the server will hand Kroger, and the exact string that has to
   * be registered on the Kroger app. Empty when unconfigured.
   *
   * Shown rather than guessed from `window.location.origin`, because it is the
   * server's setting that Kroger checks, and the two disagreeing is precisely
   * the case worth seeing. A mismatch is refused at Kroger before the browser
   * comes back, so the app can never detect it - only make it easy to check.
   */
  redirect_uri: string;
}

/** One line as it would be ordered: your word for it, Kroger's, and how many. */
export interface CartLine {
  key: string;
  name: string;
  upc: string;
  description: string;
  size: string;
  quantity: number;
  /**
   * The week's requirement the quantity is meant to cover, as the grocery
   * list shows it. "2 × 1 lb, for 1½ lb" can be checked; a bare "2" can only
   * be trusted.
   */
  amounts: string[];
  /** Why the count is one by default rather than worked out, when it is. */
  issue: LineIssue | null;
}

/**
 * A line an earlier send this trip already put in the cart. A fact about
 * this app's request, not the cart, which cannot be read: it is "sent",
 * never "in your cart".
 */
export interface SentLine {
  key: string;
  name: string;
  description: string;
  quantity: number;
  sent_at: string;
}

/**
 * What sending the list would order, and what it would leave behind.
 *
 * `skipped` names the lines rather than counting them, because a count is not
 * something you can shop from. `out_of_stock` are matched and priced and still
 * not orderable today. `sent` already went this trip and are left out unless
 * asked for again.
 */
export interface CartPlan {
  lines: CartLine[];
  skipped: string[];
  out_of_stock: string[];
  sent: SentLine[];
}

/**
 * What actually went to Kroger.
 *
 * `sent_at` is null when nothing did. The server re-plans as it sends, so a
 * line that has gone since the review can leave this at zero, and a time
 * stamped on a send of nothing would make the page warn about a duplicate
 * order that was never placed.
 */
export interface CartResult {
  added: number;
  skipped: string[];
  sent_at: string | null;
}

/**
 * The request never reached the server, so there is no answer to report.
 *
 * Worth its own type because it is the one failure that is usually about to
 * stop being true: the app is reached over Tailscale, and a launch from the
 * iOS home screen routinely fires its first request before the tunnel has
 * finished coming up. Callers retry this and nothing else - an HTTP status is
 * the server's considered answer, and asking again will not change it.
 */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    // Browsers word this for developers ("Load failed", "Failed to fetch");
    // the cause is kept for the console and this stands in for the user.
    super("Could not reach the server.");
    this.name = "NetworkError";
    this.cause = cause;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(path, {
      headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      ...init,
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      // FastAPI puts the human-readable reason in `detail`; anything else on
      // the wire is not something we can show, so statusText stands.
      const body: unknown = await resp.json();
      if (body && typeof body === "object" && "detail" in body) {
        if (typeof body.detail === "string") detail = body.detail;
      }
    } catch {
      // keep statusText
    }
    throw new Error(detail);
  }
  if (resp.status === 204) return undefined as T;
  // The server is the only source of these shapes, so the caller's `T` is the
  // contract; there is nothing here to validate it against.
  return resp.json() as Promise<T>;
}

export function imageUrl(filename: string | null): string | null {
  return filename ? `/api/images/${filename}` : null;
}

/** A "?a=1&b=2" string, dropping the params the caller left unset. */
function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export const api = {
  listRecipes: ({ q, tag, sort, page, per_page }: RecipeQuery = {}) =>
    request<Page<RecipeSummary>>(
      `/api/recipes${queryString({ q, tag, sort, page, per_page })}`,
    ),
  listRecipeTags: () => request<TagCount[]>("/api/recipes/tags"),
  getRecipe: (id: number) => request<Recipe>(`/api/recipes/${id}`),
  createRecipe: (data: RecipeInput) =>
    request<Recipe>("/api/recipes", { method: "POST", body: JSON.stringify(data) }),
  updateRecipe: (id: number, data: RecipeInput) =>
    request<Recipe>(`/api/recipes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRecipe: (id: number) =>
    request<void>(`/api/recipes/${id}`, { method: "DELETE" }),
  uploadImage: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<Recipe>(`/api/recipes/${id}/image`, { method: "POST", body: form });
  },
  deleteImage: (id: number) =>
    request<Recipe>(`/api/recipes/${id}/image`, { method: "DELETE" }),
  imageFromUrl: (id: number, url: string) =>
    request<Recipe>(`/api/recipes/${id}/image-from-url`, {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  importRecipe: (url: string) =>
    request<RecipeDraft>("/api/import/recipe", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  searchRecipes: (query: string) =>
    request<RecipeDraft[]>("/api/import/search", {
      method: "POST",
      body: JSON.stringify({ query }),
    }),

  listMealPlan: (start: string, end: string) =>
    request<MealPlanEntry[]>(`/api/meal-plan?start=${start}&end=${end}`),
  addMealPlanEntry: (plan_date: string, meal: Meal, recipe_id: number) =>
    request<MealPlanEntry>("/api/meal-plan", {
      method: "POST",
      body: JSON.stringify({ plan_date, meal, recipe_id }),
    }),
  updateMealPlanServings: (id: number, servings: number | null) =>
    request<MealPlanEntry>(`/api/meal-plan/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ servings }),
    }),
  deleteMealPlanEntry: (id: number) =>
    request<void>(`/api/meal-plan/${id}`, { method: "DELETE" }),
  copyWeek: (from_start: string, to_start: string) =>
    request<MealPlanEntry[]>("/api/meal-plan/copy-week", {
      method: "POST",
      body: JSON.stringify({ from_start, to_start }),
    }),

  listPantry: () => request<PantryItem[]>("/api/pantry"),
  addPantryItem: (name: string, in_stock: boolean) =>
    request<PantryItem>("/api/pantry", {
      method: "POST",
      body: JSON.stringify({ name, in_stock }),
    }),
  updatePantryItem: (id: number, data: Partial<Pick<PantryItem, "name" | "in_stock">>) =>
    request<PantryItem>(`/api/pantry/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deletePantryItem: (id: number) =>
    request<void>(`/api/pantry/${id}`, { method: "DELETE" }),

  groceryList: (start: string, end: string) =>
    request<GroceryList>(`/api/grocery-list?start=${start}&end=${end}`),
  /** The prices for the same list, fetched after it. Empty when pricing is off. */
  groceryPrices: (start: string, end: string) =>
    request<GroceryPrices>(`/api/grocery-list/prices?start=${start}&end=${end}`),
  /** Say what a line is this trip. "to_buy" takes any mark off it. */
  markGroceryItem: (key: string, status: GroceryStatus) =>
    request<void>("/api/grocery-list/mark", {
      method: "POST",
      body: JSON.stringify({ key, status }),
    }),
  /** Clear every mark, bought and at-home alike. */
  newGroceryTrip: () => request<void>("/api/grocery-list/new-trip", { method: "POST" }),

  pricingStatus: () => request<PricingStatus>("/api/pricing/status"),
  /** Reasons to cook something this week. Answered from picks already made, never a search. */
  suggestions: () => request<Suggestions>("/api/recipes/suggestions"),
  /** Recipes with ingredient rows that will price or shop wrongly, most first. */
  recipesAttention: () => request<RecipeAttention[]>("/api/recipes/attention"),
  /** What a recipe costs to cook. Null when there is nothing to price it with. */
  recipeCost: (id: number) => request<RecipeCost | null>(`/api/recipes/${id}/cost`),
  /** What the meals in a range cost to cook, day by day. Null when pricing is off. */
  planCost: (start: string, end: string) =>
    request<PlanCost | null>(`/api/meal-plan/cost${queryString({ start, end })}`),
  /** Every ingredient the chosen store has a remembered answer for. */
  rememberedPicks: () => request<RememberedPick[]>("/api/pricing/matches"),
  matchAlternatives: (key: string) =>
    request<ItemPrice[]>(`/api/pricing/alternatives?key=${encodeURIComponent(key)}`),
  /** `product_id` null marks the line as one not to price. */
  setMatch: (canonical_key: string, product_id: string | null) =>
    request<void>("/api/pricing/match", {
      method: "PUT",
      body: JSON.stringify({ canonical_key, product_id }),
    }),
  /** Drop a remembered pick, hand-made or not, so the matcher chooses again. */
  forgetMatch: (key: string) =>
    request<void>(`/api/pricing/match?key=${encodeURIComponent(key)}`, { method: "DELETE" }),
  searchStores: (zip: string) =>
    request<Store[]>(`/api/pricing/stores?zip=${encodeURIComponent(zip)}`),
  selectStore: (location_id: string) =>
    request<Store>("/api/pricing/store", {
      method: "PUT",
      body: JSON.stringify({ location_id }),
    }),
  clearStore: () => request<void>("/api/pricing/store", { method: "DELETE" }),

  cartStatus: () => request<CartStatus>("/api/cart/status"),
  /** Where to send the browser so Kroger can ask about granting cart access. */
  cartSignInUrl: () => request<{ url: string }>("/api/cart/sign-in"),
  disconnectCart: () => request<void>("/api/cart/connection", { method: "DELETE" }),
  /** What sending this range would order. A read: nothing reaches the cart. */
  cartPreview: (start: string, end: string) =>
    request<CartPlan>(`/api/cart/preview${queryString({ start, end })}`),
  /**
   * Send the list for a date range.
   *
   * A range rather than the lines on screen: the server rebuilds the list and
   * re-picks the products, so what is ordered is what it would have priced.
   * The one thing it takes from here is a count per line the shopper changed
   * in the review, which cannot put anything in the cart the plan did not
   * already carry. Sent only when there is one, so an untouched review sends
   * exactly what it always did.
   */
  addToCart: (
    start: string,
    end: string,
    modality: Modality,
    quantities: Record<string, number> = {},
    resend: string[] = [],
  ) =>
    request<CartResult>("/api/cart/add", {
      method: "POST",
      body: JSON.stringify({
        start,
        end,
        modality,
        ...(Object.keys(quantities).length > 0 ? { quantities } : {}),
        ...(resend.length > 0 ? { resend } : {}),
      }),
    }),
};
