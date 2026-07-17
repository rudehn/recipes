import { useEffect, useState } from "react";

import { api, type PantryItem } from "../api";

export default function PantryPage() {
  const [items, setItems] = useState<PantryItem[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function reload() {
    api.listPantry().then(setItems).catch(() => setItems([]));
  }

  useEffect(reload, []);

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return;
    try {
      await api.addPantryItem(name.trim(), true);
      setName("");
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add item.");
    }
  }

  async function setStock(item: PantryItem, in_stock: boolean) {
    setItems((prev) =>
      prev ? prev.map((i) => (i.id === item.id ? { ...i, in_stock } : i)) : prev,
    );
    await api.updatePantryItem(item.id, { in_stock });
    reload();
  }

  async function remove(item: PantryItem) {
    await api.deletePantryItem(item.id);
    reload();
  }

  const outCount = items?.filter((i) => !i.in_stock).length ?? 0;

  return (
    <div className="pantry-layout">
      <div className="page-head">
        <h1>Pantry</h1>
        <span className="sub">
          {items && items.length > 0
            ? outCount > 0
              ? `${outCount} item${outCount === 1 ? "" : "s"} to restock`
              : "Fully stocked"
            : ""}
        </span>
      </div>

      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Staples you always want on hand. Items marked out of stock are added to your
        grocery list automatically, and in-stock staples are skipped when a recipe
        calls for them.
      </p>

      <form className="pantry-add" onSubmit={addItem}>
        <input
          placeholder="Add a staple, e.g. olive oil"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="btn primary">
          Add
        </button>
      </form>

      {error && <div className="error-banner" style={{ marginBottom: 16 }}>{error}</div>}

      {items && items.length === 0 && (
        <div className="empty-state">
          <div className="glyph">🫙</div>
          <h2>No pantry staples yet</h2>
          <p>Add the basics you always keep around, like salt, rice, or coffee.</p>
        </div>
      )}

      {items?.map((item) => (
        <div key={item.id} className={`pantry-item${item.in_stock ? "" : " out"}`}>
          <span className="name">{item.name}</span>
          <button
            className="stock-toggle"
            onClick={() => setStock(item, !item.in_stock)}
            aria-pressed={item.in_stock}
          >
            <span className={`switch${item.in_stock ? " on" : ""}`} />
            {item.in_stock ? "In stock" : "Out of stock"}
          </button>
          <button
            className="icon-btn"
            aria-label={`Delete ${item.name}`}
            onClick={() => remove(item)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
