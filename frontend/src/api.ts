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

export interface Ingredient {
  id?: number;
  name: string;
  quantity: number | null;
  unit: string | null;
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

export interface GroceryItem {
  key: string;
  name: string;
  amounts: string[];
  uses: GroceryRecipeUse[];
  checked: boolean;
  from_pantry: boolean;
  pantry_item_id: number | null;
  /** Absent when pricing is off, or when nothing confident matched this line. */
  price: ItemPrice | null;
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
}

/** One line as it would be ordered: your word for it, Kroger's, and how many. */
export interface CartLine {
  key: string;
  name: string;
  upc: string;
  description: string;
  size: string;
  quantity: number;
}

/**
 * What sending the list would order, and what it would leave behind.
 *
 * `skipped` names the lines rather than counting them, because a count is not
 * something you can shop from.
 */
export interface CartPlan {
  lines: CartLine[];
  skipped: string[];
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
  toggleGroceryItem: (key: string, checked: boolean) =>
    request<void>("/api/grocery-list/toggle", {
      method: "POST",
      body: JSON.stringify({ key, checked }),
    }),
  clearGroceryChecks: () =>
    request<void>("/api/grocery-list/clear-checks", { method: "POST" }),

  pricingStatus: () => request<PricingStatus>("/api/pricing/status"),
  sales: () => request<SaleItem[]>("/api/pricing/sales"),
  matchAlternatives: (key: string) =>
    request<ItemPrice[]>(`/api/pricing/alternatives?key=${encodeURIComponent(key)}`),
  /** `product_id` null marks the line as one not to price. */
  setMatch: (canonical_key: string, product_id: string | null) =>
    request<void>("/api/pricing/match", {
      method: "PUT",
      body: JSON.stringify({ canonical_key, product_id }),
    }),
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
   */
  addToCart: (start: string, end: string, modality: Modality) =>
    request<CartResult>("/api/cart/add", {
      method: "POST",
      body: JSON.stringify({ start, end, modality }),
    }),
};
