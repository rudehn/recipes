import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, type IngredientSummary } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead, Segmented, Switch } from "../components/ui";
import { PROBLEM_GROUPS, PROBLEM_LABELS, matchesSearch, summaryLine } from "../ingredients";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

type View = "staples" | "all" | "look";
const VIEWS: readonly View[] = ["staples", "all", "look"];
const VIEW_KEY = "ingredients-view";

const isView = (value: string | null): value is View => VIEWS.includes(value as View);

/** The view this device used last. A per-device convenience, lost harmlessly. */
function storedView(): View {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return isView(stored) ? stored : "staples";
  } catch {
    return "staples";
  }
}

/** Whether anything about an ingredient needs a look, merges aside. */
const needsLook = (item: IngredientSummary) => item.problems.some((p) => p !== "merge");

/**
 * The Ingredients tab: every ingredient seen whole, starting from the staples.
 *
 * It replaced Pantry, so its first screen is the pantry's job - restocking -
 * and stays one tap from the cupboard: staples that ran out come first, and
 * the switch is on the row. Everything else about an ingredient is on its
 * own page, which each name links to. See the spec in
 * docs/superpowers/specs/2026-10-04-ingredients-page-design.md.
 */
export default function IngredientsPage() {
  const { data, setData, error, reload } = useLoad(useCallback(() => api.listIngredients(), []));
  const action = useAction();
  const [params] = useSearchParams();
  // A link may ask for a view ("Needs a look" from the recipe box); otherwise
  // the page opens where this device left it.
  const [view, setView] = useState<View>(() => {
    const asked = params.get("view");
    return isView(asked) ? asked : storedView();
  });
  const [query, setQuery] = useState("");

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // A per-device convenience; nothing is lost if it cannot be kept.
    }
  }, [view]);

  const staples = (data?.ingredients ?? []).filter((i) => i.staple !== null);
  const toRestock = staples.filter((i) => !i.staple!.in_stock).length;

  const all = data?.ingredients ?? [];
  const look = all.filter(needsLook);
  const shown = (view === "staples" ? staples : view === "all" ? all : look).filter((i) =>
    matchesSearch(i, query),
  );

  function showStock(key: string, in_stock: boolean) {
    setData(
      (prev) =>
        prev && {
          ...prev,
          ingredients: prev.ingredients.map((i) =>
            i.key === key && i.staple ? { ...i, staple: { ...i.staple, in_stock } } : i,
          ),
        },
    );
  }

  async function setStock(item: IngredientSummary, in_stock: boolean) {
    const kept = item.staple!;
    // Flipped first, as the pantry always did: the switch is the whole
    // interaction, and a round trip before it moves feels broken. Put back
    // if the server disagrees, since a switch that lies sends the next
    // grocery list to the wrong section.
    showStock(item.key, in_stock);
    if (
      await action.run(
        () => api.updatePantryItem(kept.id, { in_stock }),
        () => showStock(item.key, kept.in_stock),
      )
    ) {
      reload();
    }
  }

  async function addStaple(name: string): Promise<boolean> {
    const added = await action.run(() => api.addPantryItem(name, true));
    if (added) reload();
    return added;
  }

  return (
    <div className="ingredients-layout">
      <PageHead
        title="Ingredients"
        sub={staples.length === 0 ? "" : toRestock > 0 ? `${toRestock} to restock` : "Fully stocked"}
      />

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      {error && (
        <LoadFailure what="your ingredients" message={error} onRetry={reload} showing={data !== null} />
      )}

      {data && (
        <>
          <div className="ingredients-controls">
            <Segmented
              label="Show"
              value={view}
              onChange={setView}
              options={[
                { value: "staples", label: <>Staples <span className="count">{staples.length}</span></> },
                { value: "all", label: <>All <span className="count">{all.length}</span></> },
                { value: "look", label: <>Needs a look <span className="count">{look.length}</span></> },
              ]}
            />
            <input
              className="searchbar"
              type="search"
              aria-label="Search ingredients"
              placeholder="Search ingredients…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          {query.trim() && shown.length === 0 && (
            <p className="list-status">No ingredients match “{query.trim()}”.</p>
          )}

          {view === "staples" && (
            <StaplesView staples={shown} query={query} onToggle={setStock} onAdd={addStaple} />
          )}
          {view === "all" && shown.map((item) => <IngredientRow key={item.key} item={item} />)}
          {view === "look" && <LookView items={shown} />}
        </>
      )}
    </div>
  );
}

function StaplesView({
  staples,
  query,
  onToggle,
  onAdd,
}: {
  staples: IngredientSummary[];
  query: string;
  onToggle: (item: IngredientSummary, inStock: boolean) => void;
  onAdd: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const typed = name.trim();
    if (!typed) return;
    if (await onAdd(typed)) setName("");
  }

  return (
    <>
      <p className="page-note">
        Staples you always keep on hand. One that runs out goes on the grocery list by itself, and
        one in stock is set aside when a recipe calls for it - with the amount, so you can still
        buy more.
      </p>

      <form className="pantry-add" onSubmit={submit}>
        <input
          aria-label="Add a staple"
          placeholder="Add a staple, e.g. olive oil"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>

      {staples.length === 0 && !query && (
        <EmptyState glyph="🫙" title="No staples yet">
          <p>Add the basics you always keep around, like salt, rice, or coffee.</p>
        </EmptyState>
      )}

      <StapleGroup
        title="To restock"
        items={staples.filter((i) => !i.staple!.in_stock)}
        onToggle={onToggle}
      />
      <StapleGroup
        title="In stock"
        items={staples.filter((i) => i.staple!.in_stock)}
        onToggle={onToggle}
      />
    </>
  );
}

function StapleGroup({
  title,
  items,
  onToggle,
}: {
  title: string;
  items: IngredientSummary[];
  onToggle: (item: IngredientSummary, inStock: boolean) => void;
}) {
  if (items.length === 0) return null;
  return (
    <section className="ingredient-group" aria-label={title}>
      <h2>{title}</h2>
      {items.map((item) => {
        const kept = item.staple!;
        return (
          <div key={item.key} className={`pantry-item${kept.in_stock ? "" : " out"}`}>
            <Link className="name" to={`/ingredients/${item.key}`}>
              {kept.name}
            </Link>
            <Switch on={kept.in_stock} onToggle={() => onToggle(item, !kept.in_stock)}>
              {kept.in_stock ? "In stock" : "Out of stock"}
            </Switch>
          </div>
        );
      })}
    </section>
  );
}

function IngredientRow({ item }: { item: IngredientSummary }) {
  return (
    <Link to={`/ingredients/${item.key}`} className="ingredient-row">
      <span className="name">{item.name}</span>
      <span className="meta">{summaryLine(item)}</span>
      {item.problems.length > 0 && (
        <span className="tags">
          {item.problems.map((problem) => (
            <span key={problem} className="issue-tag">
              {PROBLEM_LABELS[problem]}
            </span>
          ))}
        </span>
      )}
    </Link>
  );
}

/**
 * Grouped by the job each needs, because the fixes differ: a product is
 * chosen at the store, a food from USDA's, a line is edited in its recipe.
 * An ingredient with two problems is in two groups, once for each fix.
 */
function LookView({ items }: { items: IngredientSummary[] }) {
  const groups = PROBLEM_GROUPS.map(
    ([problem, heading]) => [heading, items.filter((i) => i.problems.includes(problem))] as const,
  ).filter(([, found]) => found.length > 0);

  if (groups.length === 0) {
    return (
      <EmptyState glyph="✅" title="Nothing needs a look">
        <p>Every ingredient has a product, a food and a recipe line that reads right.</p>
      </EmptyState>
    );
  }
  return (
    <>
      {groups.map(([heading, found]) => (
        <section key={heading} className="ingredient-group" aria-label={heading}>
          <h2>{heading}</h2>
          {found.map((item) => (
            <IngredientRow key={item.key} item={item} />
          ))}
        </section>
      ))}
    </>
  );
}
