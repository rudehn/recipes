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

export interface GroceryRecipeUse {
  recipe_id: number;
  recipe_title: string;
  quantity: number | null;
  unit: string | null;
}

export interface GroceryItem {
  key: string;
  name: string;
  amounts: string[];
  uses: GroceryRecipeUse[];
  checked: boolean;
  from_pantry: boolean;
  pantry_item_id: number | null;
}

export interface GroceryList {
  start: string;
  end: string;
  items: GroceryItem[];
  /** Planned ingredients the pantry already has. Not bought unless asked for. */
  in_pantry: GroceryItem[];
  pantry_restock: GroceryItem[];
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
  searchStores: (zip: string) =>
    request<Store[]>(`/api/pricing/stores?zip=${encodeURIComponent(zip)}`),
  selectStore: (location_id: string) =>
    request<Store>("/api/pricing/store", {
      method: "PUT",
      body: JSON.stringify({ location_id }),
    }),
  clearStore: () => request<void>("/api/pricing/store", { method: "DELETE" }),
};
