import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type GroceryItem, type GroceryList } from "../api";
import { LoadFailure } from "../components/LoadError";
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

function applyUnsaved(list: GroceryList | null, unsaved: Unsaved): GroceryList | null {
  if (!list || unsaved.size === 0) return list;
  const apply = (item: GroceryItem) =>
    unsaved.has(item.key) ? { ...item, checked: unsaved.get(item.key)! } : item;
  return {
    ...list,
    items: list.items.map(apply),
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
  const empty = list && list.items.length === 0 && list.pantry_restock.length === 0;

  return (
    <div className="grocery-layout">
      <div className="page-head">
        <h1>Groceries</h1>
        <span className="sub">
          {rangeDays > 0 ? `${rangeDays} day${rangeDays === 1 ? "" : "s"} of meals` : ""}
        </span>
      </div>

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
        <span style={{ flex: 1 }} />
        <button className="btn small" onClick={clearChecks}>
          Clear checkmarks
        </button>
      </div>

      {action.error && (
        <div className="error-banner" style={{ marginBottom: 16 }}>{action.error}</div>
      )}

      {unsaved.size > 0 && (
        <div className="notice-banner" role="status">
          <span>
            {unsaved.size} checkmark{unsaved.size === 1 ? "" : "s"} not saved yet. They
            are on this list but not on your other devices.
          </span>
          <button className="btn small" onClick={saveUnsaved} disabled={saving}>
            {saving ? "Saving…" : "Save now"}
          </button>
        </div>
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
        <div className="empty-state">
          <div className="glyph">🧺</div>
          <h2>Nothing to buy</h2>
          <p>
            Plan some meals for this date range, or mark pantry items out of stock,
            and they will show up here.
          </p>
        </div>
      )}

      {list && list.items.length > 0 && (
        <section className="grocery-section">
          <h2>
            To buy <span className="count">{list.items.length} items</span>
          </h2>
          {list.items.map((item) => (
            <GroceryRow key={item.key} item={item} onToggle={toggle} />
          ))}
        </section>
      )}

      {list && list.pantry_restock.length > 0 && (
        <section className="grocery-section">
          <h2>
            Restock pantry{" "}
            <span className="count">{list.pantry_restock.length} items</span>
          </h2>
          {list.pantry_restock.map((item) => (
            <GroceryRow key={item.key} item={item} onToggle={toggle} />
          ))}
        </section>
      )}
    </div>
  );
}

function GroceryRow({
  item,
  onToggle,
}: {
  item: GroceryItem;
  onToggle: (item: GroceryItem) => void;
}) {
  const recipeTitles = [...new Set(item.uses.map((u) => u.recipe_title))];
  return (
    <label className={`grocery-item${item.checked ? " checked" : ""}`}>
      <input
        type="checkbox"
        checked={item.checked}
        onChange={() => onToggle(item)}
      />
      <span style={{ flex: 1 }}>
        <span className="name">{item.name}</span>
        {item.amounts.length > 0 && (
          <>
            {" "}
            <span className="amounts">· {item.amounts.join(" + ")}</span>
          </>
        )}
        {recipeTitles.length > 0 && (
          <div className="uses">for {recipeTitles.join(", ")}</div>
        )}
      </span>
      {item.from_pantry && <span className="pantry-tag">pantry</span>}
    </label>
  );
}
