import { useCallback, useState } from "react";
import { Link } from "react-router-dom";

import { api, type IngredientSummary } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead, Switch } from "../components/ui";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

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

  const staples = (data?.ingredients ?? []).filter((i) => i.staple !== null);
  const toRestock = staples.filter((i) => !i.staple!.in_stock).length;

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

      {data && <StaplesView staples={staples} onToggle={setStock} onAdd={addStaple} />}
    </div>
  );
}

function StaplesView({
  staples,
  onToggle,
  onAdd,
}: {
  staples: IngredientSummary[];
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

      {staples.length === 0 && (
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
