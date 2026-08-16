import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type GroceryItem, type GroceryList } from "../api";
import { LoadFailure } from "../components/LoadError";
import { Banner, Button, EmptyState, PageHead } from "../components/ui";
import { addDays, fromISODate, startOfWeek, toISODate } from "../dates";
import { useAction } from "../useAction";
import { useLoad } from "../useLoad";

/**
 * Checkmarks the server has not accepted, by item key.
 *
 * This page is used in a grocery aisle, which is where the signal is worst, so
 * a failed toggle is expected rather than exceptional. The mark stays on
 * screen: the shopper put the thing in the cart, and quietly taking the tick
 * back would be the more damaging lie. Holding the intended state here instead
 * of only in the loaded list also means a later reload cannot silently undo it.
 */
type Unsaved = ReadonlyMap<string, boolean>;

const itemCount = (n: number) => `${n} item${n === 1 ? "" : "s"}`;

function applyUnsaved(list: GroceryList | null, unsaved: Unsaved): GroceryList | null {
  if (!list || unsaved.size === 0) return list;
  const apply = (item: GroceryItem) =>
    unsaved.has(item.key) ? { ...item, checked: unsaved.get(item.key)! } : item;
  return {
    ...list,
    items: list.items.map(apply),
    in_pantry: list.in_pantry.map(apply),
    pantry_restock: list.pantry_restock.map(apply),
  };
}

export default function GroceryPage() {
  const [params, setParams] = useSearchParams();
  const start = params.get("start") ?? toISODate(startOfWeek(new Date()));
  const end = params.get("end") ?? toISODate(addDays(startOfWeek(new Date()), 6));

  const {
    data: loaded,
    setData: setList,
    error,
    reload,
  } = useLoad(useCallback(() => api.groceryList(start, end), [start, end]));

  const [unsaved, setUnsaved] = useState<Unsaved>(new Map());
  const [saving, setSaving] = useState(false);
  const action = useAction();

  const list = useMemo(() => applyUnsaved(loaded, unsaved), [loaded, unsaved]);

  function setRange(nextStart: string, nextEnd: string) {
    if (nextStart && nextEnd) setParams({ start: nextStart, end: nextEnd });
  }

  function forget(key: string): (prev: Unsaved) => Unsaved {
    return (prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    };
  }

  async function toggle(item: GroceryItem) {
    const checked = !item.checked;
    // Optimistic flip so the list feels instant.
    setList((prev) => {
      if (!prev) return prev;
      const flip = (i: GroceryItem) => (i.key === item.key ? { ...i, checked } : i);
      return {
        ...prev,
        items: prev.items.map(flip),
        in_pantry: prev.in_pantry.map(flip),
        pantry_restock: prev.pantry_restock.map(flip),
      };
    });
    try {
      await api.toggleGroceryItem(item.key, checked);
      setUnsaved(forget(item.key));
      reload();
    } catch {
      setUnsaved((prev) => new Map(prev).set(item.key, checked));
    }
  }

  /** Send the marks again, for when the signal is back. */
  async function saveUnsaved() {
    setSaving(true);
    const stillUnsaved = new Map<string, boolean>();
    for (const [key, checked] of unsaved) {
      try {
        await api.toggleGroceryItem(key, checked);
      } catch {
        stillUnsaved.set(key, checked);
      }
    }
    setUnsaved(stillUnsaved);
    setSaving(false);
    if (stillUnsaved.size === 0) reload();
  }

  /**
   * Move a stocked staple onto the shopping list.
   *
   * Wanting more of something is the same fact as being low on it, which the
   * pantry already records - so this marks the item out of stock rather than
   * inventing a second flag. The row then appears under "to buy", and ticking
   * it off at the shop puts it back in stock the way any other staple does.
   */
  async function buyAnyway(item: GroceryItem) {
    const id = item.pantry_item_id;
    if (id === null) return;
    if (await action.run(() => api.updatePantryItem(id, { in_stock: false }))) reload();
  }

  async function clearChecks() {
    if (await action.run(() => api.clearGroceryChecks())) {
      setUnsaved(new Map());
      reload();
    }
  }

  const rangeDays =
    Math.round(
      (fromISODate(end).getTime() - fromISODate(start).getTime()) / 86_400_000,
    ) + 1;
  const empty =
    list &&
    list.items.length === 0 &&
    list.in_pantry.length === 0 &&
    list.pantry_restock.length === 0;

  return (
    <div className="grocery-layout">
      <PageHead
        title="Groceries"
        sub={rangeDays > 0 ? `${rangeDays} day${rangeDays === 1 ? "" : "s"} of meals` : ""}
      />

      <div className="grocery-range">
        <label>
          From{" "}
          <input
            type="date"
            value={start}
            onChange={(e) => setRange(e.target.value, end)}
          />
        </label>
        <label>
          to{" "}
          <input
            type="date"
            value={end}
            onChange={(e) => setRange(start, e.target.value)}
          />
        </label>
        <span className="spacer" />
        <Button size="small" onClick={clearChecks}>
          Clear checkmarks
        </Button>
      </div>

      {action.error && (
        <Banner tone="error" spaced>
          {action.error}
        </Banner>
      )}

      {unsaved.size > 0 && (
        <Banner tone="notice" spaced role="status">
          <span>
            {unsaved.size} checkmark{unsaved.size === 1 ? "" : "s"} not saved yet. They
            are on this list but not on your other devices.
          </span>
          <Button size="small" onClick={saveUnsaved} disabled={saving}>
            {saving ? "Saving…" : "Save now"}
          </Button>
        </Banner>
      )}

      {error && (
        <LoadFailure
          what="your grocery list"
          message={error}
          onRetry={reload}
          showing={list !== null}
        />
      )}

      {!error && empty && (
        <EmptyState glyph="🧺" title="Nothing to buy">
          <p>
            Plan some meals for this date range, or mark pantry items out of stock,
            and they will show up here.
          </p>
        </EmptyState>
      )}

      {list && list.items.length > 0 && (
        <section className="grocery-section">
          <h2>
            To buy <span className="count">{itemCount(list.items.length)}</span>
          </h2>
          {list.items.map((item) => (
            <GroceryRow key={item.key} item={item} onToggle={toggle} />
          ))}
        </section>
      )}

      {list && list.in_pantry.length > 0 && (
        // Folded away, because the answer for these is usually "you have it".
        // Opened when there is nothing to buy, so the page is never just a
        // heading and a number. The count stays visible either way: the point
        // is that nothing is hidden without saying so.
        <details className="grocery-section stocked-section" open={list.items.length === 0}>
          <summary>
            Already in your pantry{" "}
            <span className="count">{itemCount(list.in_pantry.length)}</span>
          </summary>
          <p className="section-note">
            Off the list because the pantry has them. Check the amounts your meals
            need if you are not sure there is enough.
          </p>
          {list.in_pantry.map((item) => (
            <StockedRow key={item.key} item={item} onBuyAnyway={buyAnyway} />
          ))}
        </details>
      )}

      {list && list.pantry_restock.length > 0 && (
        <section className="grocery-section">
          <h2>
            Restock pantry{" "}
            <span className="count">{itemCount(list.pantry_restock.length)}</span>
          </h2>
          {list.pantry_restock.map((item) => (
            <GroceryRow key={item.key} item={item} onToggle={toggle} />
          ))}
        </section>
      )}
    </div>
  );
}

/** Name, totals, and the recipes asking for it - the same in every section. */
function ItemText({ item }: { item: GroceryItem }) {
  const recipeTitles = [...new Set(item.uses.map((u) => u.recipe_title))];
  return (
    <span className="item-text">
      <span className="name">{item.name}</span>
      {item.amounts.length > 0 && (
        <>
          {" "}
          <span className="amounts">· {item.amounts.join(" + ")}</span>
        </>
      )}
      {recipeTitles.length > 0 && <div className="uses">for {recipeTitles.join(", ")}</div>}
    </span>
  );
}

function GroceryRow({
  item,
  onToggle,
}: {
  item: GroceryItem;
  onToggle: (item: GroceryItem) => void;
}) {
  return (
    <label className={`grocery-item${item.checked ? " checked" : ""}`}>
      <input
        type="checkbox"
        checked={item.checked}
        onChange={() => onToggle(item)}
      />
      <ItemText item={item} />
      {item.from_pantry && <span className="pantry-tag">pantry</span>}
    </label>
  );
}

/**
 * A stocked staple. No checkbox: there is nothing to tick off a trip you are
 * not making, and a checkbox here would read as "buy this" - the opposite of
 * what the row says. The button is the only action, and it says what it does.
 */
function StockedRow({
  item,
  onBuyAnyway,
}: {
  item: GroceryItem;
  onBuyAnyway: (item: GroceryItem) => void;
}) {
  return (
    <div className="grocery-item stocked">
      <ItemText item={item} />
      <Button size="small" onClick={() => onBuyAnyway(item)}>
        Buy anyway
      </Button>
    </div>
  );
}
