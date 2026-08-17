/**
 * Builders for the API shapes pages render.
 *
 * Each takes a partial override so a test states only the field it is about -
 * a serving-scaling test says `servings: 4` and ignores prep time - and the
 * rest stays valid.
 */

import type {
  CartLine,
  CartPlan,
  CartStatus,
  GroceryItem,
  GroceryList,
  Meal,
  MealPlanEntry,
  Page,
  PantryItem,
  Recipe,
  RecipeDraft,
  RecipeSummary,
  TagCount,
} from "../api";

let nextId = 1;

function id(): number {
  return nextId++;
}

export function recipeSummary(overrides: Partial<RecipeSummary> = {}): RecipeSummary {
  return {
    id: id(),
    title: "Weeknight chicken curry",
    description: "Fast and warming.",
    image_filename: null,
    prep_minutes: 10,
    cook_minutes: 20,
    servings: 4,
    tags: [],
    ...overrides,
  };
}

/**
 * A page of `items`. `total` defaults to what was passed, which is what a test
 * wants unless it is specifically about there being more to load.
 */
export function page<T>(items: T[], overrides: Partial<Page<T>> = {}): Page<T> {
  return { items, total: items.length, page: 1, per_page: 24, ...overrides };
}

export function tagCount(name: string, count = 1): TagCount {
  return { name, count };
}

export function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    ...recipeSummary(),
    instructions: "Season the chicken\nSimmer the sauce",
    ingredients: [{ id: id(), name: "chicken thighs", quantity: 2, unit: "lb" }],
    ...overrides,
  };
}

export function recipeDraft(overrides: Partial<RecipeDraft> = {}): RecipeDraft {
  return {
    title: "Banana bread",
    description: "A classic loaf.",
    instructions: "Mash the bananas\nBake for an hour",
    prep_minutes: 15,
    cook_minutes: 60,
    servings: 8,
    ingredients: [{ name: "bananas", quantity: 3, unit: null }],
    image_url: null,
    source_url: "https://www.budgetbytes.com/banana-bread/",
    source_label: "Budget Bytes",
    ...overrides,
  };
}

export function mealPlanEntry(overrides: Partial<MealPlanEntry> = {}): MealPlanEntry {
  return {
    id: id(),
    plan_date: "2026-07-27",
    meal: "dinner" as Meal,
    servings: null,
    recipe: recipeSummary(),
    ...overrides,
  };
}

export function pantryItem(overrides: Partial<PantryItem> = {}): PantryItem {
  return { id: id(), name: "olive oil", in_stock: true, ...overrides };
}

export function groceryItem(overrides: Partial<GroceryItem> = {}): GroceryItem {
  return {
    key: `item-${id()}`,
    name: "chicken thighs",
    amounts: ["2 lb"],
    uses: [],
    checked: false,
    from_pantry: false,
    pantry_item_id: null,
    // Unpriced by default: pricing is opt-in, so this is the ordinary line.
    price: null,
    ...overrides,
  };
}

export function groceryList(overrides: Partial<GroceryList> = {}): GroceryList {
  return {
    start: "2026-07-27",
    end: "2026-08-02",
    items: [],
    in_pantry: [],
    pantry_restock: [],
    pricing: null,
    ...overrides,
  };
}

/**
 * Set up but not signed in - the state a button fixes, and the one worth
 * defaulting to, since the other two are the ends of the range.
 */
export function cartStatus(overrides: Partial<CartStatus> = {}): CartStatus {
  return {
    configured: true,
    connected: false,
    connected_at: null,
    last_sent_at: null,
    redirect_uri: "https://recipes.test/api/cart/callback",
    ...overrides,
  };
}

export function cartLine(overrides: Partial<CartLine> = {}): CartLine {
  return {
    key: `line-${id()}`,
    name: "flour",
    upc: "0001111041700",
    description: "Kroger® All Purpose Flour",
    size: "5 lb",
    quantity: 1,
    ...overrides,
  };
}

export function cartPlan(overrides: Partial<CartPlan> = {}): CartPlan {
  return { lines: [], skipped: [], ...overrides };
}
