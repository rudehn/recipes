import { useCallback, useState } from "react";

import { api, type PantryItem } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, IconButton, PageHead, Switch } from "../components/ui";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

export default function PantryPage() {
  const {
    data: items,
    setData: setItems,
    error: loadError,
    reload,
  } = useLoad(useCallback(() => api.listPantry(), []));
  const [name, setName] = useState("");
  const action = useAction();

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (await action.run(() => api.addPantryItem(name.trim(), true))) {
      setName("");
      reload();
    }
  }

  function showStock(id: number, in_stock: boolean) {
    setItems((prev) => prev?.map((i) => (i.id === id ? { ...i, in_stock } : i)) ?? prev);
  }

  async function setStock(item: PantryItem, in_stock: boolean) {
    // Flipped first: the switch is the whole interaction, and waiting on a
    // round trip to move it feels broken. Put back if the server disagrees,
    // since a switch that says "in stock" when the server has it out of stock
    // sends the next grocery list to the wrong section.
    showStock(item.id, in_stock);
    if (await action.run(
      () => api.updatePantryItem(item.id, { in_stock }),
      () => showStock(item.id, item.in_stock),
    )) {
      reload();
    }
  }

  async function remove(item: PantryItem) {
    if (await action.run(() => api.deletePantryItem(item.id))) reload();
  }

  const outCount = items?.filter((i) => !i.in_stock).length ?? 0;

  return (
    <div className="pantry-layout">
      <PageHead
        title="Pantry"
        sub={
          items && items.length > 0
            ? outCount > 0
              ? `${outCount} item${outCount === 1 ? "" : "s"} to restock`
              : "Fully stocked"
            : ""
        }
      />

      <p className="page-note">
        Staples you always want on hand. Items marked out of stock are added to your
        grocery list automatically. When a recipe calls for one you have in stock, the
        list sets it aside instead of buying it - and shows the amount, so you can
        still buy more.
      </p>

      <form className="pantry-add" onSubmit={addItem}>
        <input
          placeholder="Add a staple, e.g. olive oil"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit" variant="primary">
          Add
        </Button>
      </form>

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      {loadError && (
        <LoadFailure
          what="your pantry"
          message={loadError}
          onRetry={reload}
          showing={items !== null}
        />
      )}

      {!loadError && items && items.length === 0 && (
        <EmptyState glyph="🫙" title="No pantry staples yet">
          <p>Add the basics you always keep around, like salt, rice, or coffee.</p>
        </EmptyState>
      )}

      {items?.map((item) => (
        <div key={item.id} className={`pantry-item${item.in_stock ? "" : " out"}`}>
          <span className="name">{item.name}</span>
          <Switch on={item.in_stock} onToggle={() => setStock(item, !item.in_stock)}>
            {item.in_stock ? "In stock" : "Out of stock"}
          </Switch>
          <IconButton label={`Delete ${item.name}`} onClick={() => remove(item)}>
            ✕
          </IconButton>
        </div>
      ))}
    </div>
  );
}
