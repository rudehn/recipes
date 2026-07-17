export type Meal = "breakfast" | "lunch" | "dinner" | "snack";

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
}

export interface Recipe extends RecipeSummary {
  instructions: string;
  ingredients: Ingredient[];
}

export interface RecipeInput {
  title: string;
  description: string;
  instructions: string;
  prep_minutes: number | null;
  cook_minutes: number | null;
  servings: number | null;
  ingredients: Omit<Ingredient, "id">[];
}

export interface MealPlanEntry {
  id: number;
  plan_date: string;
  meal: Meal;
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
  pantry_restock: GroceryItem[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: init?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...init,
  });
  if (!resp.ok) {
    let detail = resp.statusText;
    try {
      const body = await resp.json();
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      // keep statusText
    }
    throw new Error(detail);
  }
  if (resp.status === 204) return undefined as T;
  return resp.json();
}

export function imageUrl(filename: string | null): string | null {
  return filename ? `/api/images/${filename}` : null;
}

export const api = {
  listRecipes: () => request<RecipeSummary[]>("/api/recipes"),
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

  listMealPlan: (start: string, end: string) =>
    request<MealPlanEntry[]>(`/api/meal-plan?start=${start}&end=${end}`),
  addMealPlanEntry: (plan_date: string, meal: Meal, recipe_id: number) =>
    request<MealPlanEntry>("/api/meal-plan", {
      method: "POST",
      body: JSON.stringify({ plan_date, meal, recipe_id }),
    }),
  deleteMealPlanEntry: (id: number) =>
    request<void>(`/api/meal-plan/${id}`, { method: "DELETE" }),

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
};
