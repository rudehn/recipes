import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, type GroceryItem, type GroceryList } from "../api";
import { addDays, fromISODate, startOfWeek, toISODate } from "../dates";

export default function GroceryPage() {
  const [params, setParams] = useSearchParams();
  const start = params.get("start") ?? toISODate(startOfWeek(new Date()));
  const end = params.get("end") ?? toISODate(addDays(startOfWeek(new Date()), 6));
  const [list, setList] = useState<GroceryList | null>(null);

  const reload = useCallback(() => {
    api.groceryList(start, end).then(setList).catch(() => setList(null));
  }, [start, end]);

  useEffect(reload, [reload]);

  function setRange(nextStart: string, nextEnd: string) {
    if (nextStart && nextEnd) setParams({ start: nextStart, end: nextEnd });
  }

  async function toggle(item: GroceryItem) {
    // Optimistic flip so the list feels instant.
    setList((prev) => {
      if (!prev) return prev;
      const flip = (i: GroceryItem) =>
        i.key === item.key ? { ...i, checked: !item.checked } : i;
      return {
        ...prev,
        items: prev.items.map(flip),
        pantry_restock: prev.pantry_restock.map(flip),
      };
    });
    await api.toggleGroceryItem(item.key, !item.checked);
    reload();
  }

  async function clearChecks() {
    await api.clearGroceryChecks();
    reload();
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

      {empty && (
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
